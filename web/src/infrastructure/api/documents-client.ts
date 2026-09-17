/**
 * The document service's client.
 *
 * It speaks to `docgen-api`, which holds the templates and renders the files.
 * Every call carries a five-minute token minted by this API for the office, so
 * this client never sees the platform's own session.
 *
 * Field names follow `docgen-api/openapi.yaml`, which is the contract.
 */

import type {
  CallContext,
  DocumentsGateway,
  FileContent,
} from "../../application/ports.ts";
import type {
  GeneratedDocument,
  GenerateInput,
  Template,
} from "../../domain/document.ts";
import { encodeSegment, Transport, type TransportOptions } from "./transport.ts";

interface ApiTemplateVersion {
  version: number;
  placeholders: string[];
}

interface ApiTemplate {
  id: string;
  name: string;
  description: string;
  latest_version: number;
  version?: ApiTemplateVersion;
}

interface ApiDocument {
  id: string;
  template_id: string;
  template_version: number;
  filename: string;
  size: number;
  created_at: string;
  reference: string;
}

function toTemplate(body: ApiTemplate): Template {
  return {
    id: body.id,
    name: body.name,
    description: body.description,
    latestVersion: body.latest_version,
    ...(body.version === undefined
      ? {}
      : {
          version: {
            version: body.version.version,
            placeholders: body.version.placeholders,
          },
        }),
  };
}

function toDocument(body: ApiDocument): GeneratedDocument {
  return {
    id: body.id,
    templateId: body.template_id,
    templateVersion: body.template_version,
    filename: body.filename,
    size: body.size,
    createdAt: new Date(body.created_at),
    reference: body.reference,
  };
}

/** The filename the service chose, read from the Content-Disposition. */
function filenameFrom(header: string | null, fallback: string): string {
  if (header === null) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) return decodeURIComponent(encoded[1]);
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? fallback;
}

export function createDocumentsClient(options: TransportOptions): DocumentsGateway {
  const http = new Transport(options);

  return {
    async listTemplates(ctx: CallContext): Promise<Template[]> {
      // One page of a hundred: an office keeps a handful of lease models, and
      // a screen that made the person page through templates to find one would
      // be worse than a list that says it stops at a hundred.
      const body = await http.json<{ items: ApiTemplate[] }>(
        ctx,
        "GET",
        "/v1/templates?limit=100",
      );
      return body.items.map(toTemplate);
    },

    async getTemplate(ctx: CallContext, id: string): Promise<Template> {
      return toTemplate(
        await http.json<ApiTemplate>(ctx, "GET", `/v1/templates/${encodeSegment(id)}`),
      );
    },

    async downloadTemplateVersion(
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

    async generate(ctx: CallContext, input: GenerateInput): Promise<GeneratedDocument> {
      return toDocument(
        await http.json<ApiDocument>(ctx, "POST", "/v1/documents", {
          template_id: input.templateId,
          ...(input.version === undefined ? {} : { version: input.version }),
          filename: input.filename,
          reference: input.reference,
          data: input.data,
        }),
      );
    },

    async listByReference(
      ctx: CallContext,
      reference: string,
    ): Promise<GeneratedDocument[]> {
      const query = new URLSearchParams({ reference, limit: "100" });
      const body = await http.json<{ items: ApiDocument[] }>(
        ctx,
        "GET",
        `/v1/documents?${query}`,
      );
      return body.items.map(toDocument);
    },

    async download(ctx: CallContext, id: string): Promise<FileContent> {
      const response = await http.send(
        ctx,
        "GET",
        `/v1/documents/${encodeSegment(id)}/download`,
      );
      return {
        filename: filenameFrom(
          response.headers.get("content-disposition"),
          "documento.docx",
        ),
        contentType:
          response.headers.get("content-type") ??
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },

    async remove(ctx: CallContext, id: string): Promise<void> {
      await http.send(ctx, "DELETE", `/v1/documents/${encodeSegment(id)}`);
    },
  };
}
