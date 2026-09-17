/**
 * The docgen API client.
 *
 * Three gateways share one transport. They are separate objects rather than one
 * class because `TemplateGateway` and `DocumentGateway` both declare `list` and
 * `get` — a single class could not honestly implement both, and each caller
 * only ever wants one of them anyway.
 *
 * Field names follow `docgen-api/openapi.yaml`. That specification is the
 * contract; read it before changing anything here.
 */

import type {
  BatchGateway,
  CallContext,
  DocumentFilter,
  DocumentGateway,
  Caller,
  FileContent,
  OfficeGateway,
  Page,
  StatsGateway,
  TemplateGateway,
} from "../../application/ports.ts";
import type { Batch, HistoryEntry } from "../../domain/batch.ts";
import type { GeneratedDocument, GenerateInput } from "../../domain/document.ts";
import type { DashboardStats, StatsPeriod } from "../../domain/stats.ts";
import type {
  Template,
  TemplateUploadInput,
  TemplateVersion,
} from "../../domain/template.ts";
import type { Role, User } from "../../domain/user.ts";
import {
  encodeSegment,
  filenameFrom,
  pageQuery,
  Transport,
  type TransportOptions,
} from "./transport.ts";

// ----- wire shapes ---------------------------------------------------------

interface ApiUser {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

/** What the document service answers about the caller of a token. */
interface ApiCaller {
  user: ApiUser;
  office: { id: string; name: string; created_at: string };
  role: Role;
}

interface ApiTemplateVersion {
  id: string;
  version: number;
  size: number;
  placeholders: string[];
  created_at: string;
}

interface ApiTemplate {
  id: string;
  name: string;
  description: string;
  latest_version: number;
  created_at: string;
  updated_at: string;
  version?: ApiTemplateVersion;
}

interface ApiDocument {
  id: string;
  template_id: string;
  template_version: number;
  filename: string;
  size: number;
  data: Record<string, string>;
  created_at: string;
  download_url: string;
  batch_id: string | null;
}

interface ApiBatch {
  id: string;
  template_id: string;
  template_version: number;
  name: string;
  documents: number;
  size: number;
  created_at: string;
  download_url: string;
}

interface ApiHistoryItem {
  kind: "document" | "batch";
  document?: ApiDocument;
  batch?: ApiBatch;
}

interface ApiStats {
  days: number;
  time_zone: string;
  templates: number;
  documents: number;
  documents_in_period: number;
  documents_previous_period: number;
  per_day: { date: string; documents: number }[];
  top_templates: {
    template_id: string;
    name: string;
    deleted: boolean;
    documents: number;
  }[];
}

// ----- client --------------------------------------------------------------

export interface DocgenClient {
  readonly office: OfficeGateway;
  readonly templates: TemplateGateway;
  readonly documents: DocumentGateway;
  readonly batches: BatchGateway;
  readonly stats: StatsGateway;
}

export function createDocgenClient(options: TransportOptions): DocgenClient {
  const http = new Transport(options);

  return {
    office: createOfficeGateway(http),
    templates: createTemplateGateway(http),
    documents: createDocumentGateway(http),
    batches: createBatchGateway(http),
    stats: createStatsGateway(http),
  };
}

/** A page plus filters as a query string. Absent filters are left out. */
function listQuery(page: Page | undefined, filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams(pageQuery(page).slice(1));
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

function createBatchGateway(http: Transport): BatchGateway {
  return {
    async create(ctx, input): Promise<Batch> {
      const payload: Record<string, unknown> = { template_id: input.templateId, name: input.name };
      if (input.version !== undefined) payload["version"] = input.version;
      return toBatch(await http.json<ApiBatch>(ctx, "POST", "/v1/batches", payload));
    },

    async get(ctx, id): Promise<Batch> {
      return toBatch(await http.json<ApiBatch>(ctx, "GET", `/v1/batches/${encodeSegment(id)}`));
    },

    async history(ctx, page, filter): Promise<HistoryEntry[]> {
      const body = await http.json<{ items: ApiHistoryItem[] }>(
        ctx,
        "GET",
        `/v1/history${listQuery(page, { template_id: filter?.templateId })}`,
      );
      return body.items.flatMap((item): HistoryEntry[] => {
        if (item.kind === "batch" && item.batch !== undefined) {
          return [{ kind: "batch", batch: toBatch(item.batch) }];
        }
        if (item.kind === "document" && item.document !== undefined) {
          return [{ kind: "document", document: toDocument(item.document) }];
        }
        // A kind this client does not know is skipped rather than guessed at.
        return [];
      });
    },

    async download(ctx, id): Promise<FileContent> {
      const response = await http.send(ctx, "GET", `/v1/batches/${encodeSegment(id)}/download`);
      return {
        filename: filenameFrom(response.headers.get("content-disposition")),
        contentType: response.headers.get("content-type") ?? "application/zip",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },

    async remove(ctx, id): Promise<void> {
      await http.send(ctx, "DELETE", `/v1/batches/${encodeSegment(id)}`);
    },
  };
}

function createStatsGateway(http: Transport): StatsGateway {
  return {
    async get(ctx, { days, timeZone }): Promise<DashboardStats> {
      const query = new URLSearchParams({ days: String(days), tz: timeZone });
      return toStats(await http.json<ApiStats>(ctx, "GET", `/v1/me/stats?${query}`));
    },
  };
}

function createOfficeGateway(http: Transport): OfficeGateway {
  return {
    async current(ctx: CallContext): Promise<Caller> {
      const body = await http.json<ApiCaller>(ctx, "GET", "/v1/me");
      return {
        user: toUser(body.user),
        office: { id: body.office.id, name: body.office.name },
        role: body.role,
      };
    },

    async exportOffice(ctx: CallContext): Promise<FileContent> {
      const response = await http.send(ctx, "GET", "/v1/me/export");
      return {
        filename: filenameFrom(response.headers.get("content-disposition")),
        contentType: response.headers.get("content-type") ?? "application/json",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

function createTemplateGateway(http: Transport): TemplateGateway {
  return {
    async list(ctx: CallContext, page?: Page): Promise<Template[]> {
      const body = await http.json<{ items: ApiTemplate[] }>(
        ctx,
        "GET",
        `/v1/templates${pageQuery(page)}`,
      );
      return body.items.map(toTemplate);
    },

    async get(ctx: CallContext, id: string): Promise<Template> {
      return toTemplate(
        await http.json<ApiTemplate>(
          ctx,
          "GET",
          `/v1/templates/${encodeSegment(id)}`,
        ),
      );
    },

    async versions(
      ctx: CallContext,
      id: string,
      page?: Page,
    ): Promise<TemplateVersion[]> {
      const body = await http.json<{ items: ApiTemplateVersion[] }>(
        ctx,
        "GET",
        `/v1/templates/${encodeSegment(id)}/versions${pageQuery(page)}`,
      );
      return body.items.map(toTemplateVersion);
    },

    async create(
      ctx: CallContext,
      input: TemplateUploadInput,
    ): Promise<Template> {
      const form = new FormData();
      form.set("name", input.name);
      form.set("description", input.description);
      form.set("file", input.file, input.file.name);

      return toTemplate(
        await http.json<ApiTemplate>(ctx, "POST", "/v1/templates", form),
      );
    },

    async addVersion(
      ctx: CallContext,
      id: string,
      file: File,
    ): Promise<Template> {
      const form = new FormData();
      form.set("file", file, file.name);

      return toTemplate(
        await http.json<ApiTemplate>(
          ctx,
          "POST",
          `/v1/templates/${encodeSegment(id)}/versions`,
          form,
        ),
      );
    },

    async remove(ctx: CallContext, id: string): Promise<void> {
      await http.send(ctx, "DELETE", `/v1/templates/${encodeSegment(id)}`);
    },

    async downloadVersion(
      ctx: CallContext,
      id: string,
      version: number,
    ): Promise<Uint8Array> {
      const response = await http.send(
        ctx,
        "GET",
        `/v1/templates/${encodeSegment(id)}/versions/${version}/file`,
      );
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function createDocumentGateway(http: Transport): DocumentGateway {
  return {
    async list(ctx: CallContext, page?: Page, filter?: DocumentFilter): Promise<GeneratedDocument[]> {
      const body = await http.json<{ items: ApiDocument[] }>(
        ctx,
        "GET",
        `/v1/documents${listQuery(page, {
          template_id: filter?.templateId,
          batch_id: filter?.batchId,
          order: filter?.order,
        })}`,
      );
      return body.items.map(toDocument);
    },

    async get(ctx: CallContext, id: string): Promise<GeneratedDocument> {
      return toDocument(
        await http.json<ApiDocument>(
          ctx,
          "GET",
          `/v1/documents/${encodeSegment(id)}`,
        ),
      );
    },

    async generate(
      ctx: CallContext,
      input: GenerateInput,
    ): Promise<GeneratedDocument> {
      const payload: Record<string, unknown> = {
        template_id: input.templateId,
        data: input.data,
      };
      // Omitted rather than sent as null: the API treats an absent version as
      // "use the latest", and an absent filename as "pick one".
      if (input.version !== undefined) payload["version"] = input.version;
      if (input.filename !== undefined) payload["filename"] = input.filename;
      if (input.batchId !== undefined) payload["batch_id"] = input.batchId;

      return toDocument(
        await http.json<ApiDocument>(ctx, "POST", "/v1/documents", payload),
      );
    },

    async download(ctx: CallContext, id: string): Promise<FileContent> {
      const response = await http.send(
        ctx,
        "GET",
        `/v1/documents/${encodeSegment(id)}/download`,
      );

      return {
        filename: filenameFrom(response.headers.get("content-disposition")),
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },

    async remove(ctx: CallContext, id: string): Promise<void> {
      await http.send(ctx, "DELETE", `/v1/documents/${encodeSegment(id)}`);
    },
  };
}

// ----- mapping -------------------------------------------------------------

function toUser(body: ApiUser): User {
  return {
    id: body.id,
    email: body.email,
    name: body.name,
    createdAt: new Date(body.created_at),
  };
}

function toTemplateVersion(body: ApiTemplateVersion): TemplateVersion {
  return {
    id: body.id,
    version: body.version,
    size: body.size,
    placeholders: body.placeholders,
    createdAt: new Date(body.created_at),
  };
}

function toTemplate(body: ApiTemplate): Template {
  return {
    id: body.id,
    name: body.name,
    description: body.description,
    latestVersion: body.latest_version,
    createdAt: new Date(body.created_at),
    updatedAt: new Date(body.updated_at),
    ...(body.version === undefined
      ? {}
      : { version: toTemplateVersion(body.version) }),
  };
}

function toStats(body: ApiStats): DashboardStats {
  return {
    // The API only ever answers with a window it offers.
    days: body.days as StatsPeriod,
    timeZone: body.time_zone,
    templates: body.templates,
    documents: body.documents,
    documentsInPeriod: body.documents_in_period,
    documentsPreviousPeriod: body.documents_previous_period,
    perDay: body.per_day.map((d) => ({ date: d.date, documents: d.documents })),
    topTemplates: body.top_templates.map((t) => ({
      templateId: t.template_id,
      name: t.name,
      deleted: t.deleted,
      documents: t.documents,
    })),
  };
}

function toDocument(body: ApiDocument): GeneratedDocument {
  return {
    id: body.id,
    templateId: body.template_id,
    templateVersion: body.template_version,
    filename: body.filename,
    size: body.size,
    data: body.data,
    createdAt: new Date(body.created_at),
    downloadUrl: body.download_url,
    batchId: body.batch_id ?? null,
  };
}

function toBatch(body: ApiBatch): Batch {
  return {
    id: body.id,
    templateId: body.template_id,
    templateVersion: body.template_version,
    name: body.name,
    documents: body.documents,
    size: body.size,
    createdAt: new Date(body.created_at),
    downloadUrl: body.download_url,
  };
}
