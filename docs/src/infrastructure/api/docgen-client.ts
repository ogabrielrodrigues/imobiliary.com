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
  AuthGateway,
  CallContext,
  DocumentGateway,
  FileContent,
  Page,
  TemplateGateway,
} from "../../application/ports.ts";
import type { GeneratedDocument, GenerateInput } from "../../domain/document.ts";
import type {
  Template,
  TemplateUploadInput,
  TemplateVersion,
} from "../../domain/template.ts";
import type {
  LoginInput,
  PasswordChangeInput,
  RegistrationInput,
  Session,
  User,
} from "../../domain/user.ts";
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

interface ApiSession {
  access_token: string;
  token_type: string;
  expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  user: ApiUser;
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
}

// ----- client --------------------------------------------------------------

export interface DocgenClient {
  readonly auth: AuthGateway;
  readonly templates: TemplateGateway;
  readonly documents: DocumentGateway;
}

export function createDocgenClient(options: TransportOptions): DocgenClient {
  const http = new Transport(options);

  return {
    auth: createAuthGateway(http),
    templates: createTemplateGateway(http),
    documents: createDocumentGateway(http),
  };
}

function createAuthGateway(http: Transport): AuthGateway {
  return {
    async register(ctx: CallContext, input: RegistrationInput): Promise<User> {
      return toUser(
        await http.json<ApiUser>(ctx, "POST", "/v1/auth/register", {
          email: input.email,
          name: input.name,
          password: input.password,
          // Required by the API since acceptance began being recorded. Leaving
          // it out fails the whole registration with a 422 naming a field the
          // form does not show, which is how this was missed.
          terms_version: input.termsVersion,
        }),
      );
    },

    async deleteAccount(ctx: CallContext): Promise<void> {
      await http.send(ctx, "DELETE", "/v1/me");
    },

    async exportAccount(ctx: CallContext): Promise<FileContent> {
      const response = await http.send(ctx, "GET", "/v1/me/export");
      return {
        filename: filenameFrom(response.headers.get("content-disposition")),
        contentType: response.headers.get("content-type") ?? "application/json",
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },

    async login(ctx: CallContext, input: LoginInput): Promise<Session> {
      return toSession(
        await http.json<ApiSession>(ctx, "POST", "/v1/auth/login", {
          email: input.email,
          password: input.password,
        }),
      );
    },

    async refresh(ctx: CallContext, refreshToken: string): Promise<Session> {
      return toSession(
        await http.json<ApiSession>(ctx, "POST", "/v1/auth/refresh", {
          refresh_token: refreshToken,
        }),
      );
    },

    async logout(ctx: CallContext, refreshToken: string): Promise<void> {
      await http.send(ctx, "POST", "/v1/auth/logout", {
        body: JSON.stringify({ refresh_token: refreshToken }),
        contentType: "application/json",
      });
    },

    async currentUser(ctx: CallContext): Promise<User> {
      return toUser(await http.json<ApiUser>(ctx, "GET", "/v1/me"));
    },

    async changePassword(
      ctx: CallContext,
      input: PasswordChangeInput,
    ): Promise<Session> {
      return toSession(
        await http.json<ApiSession>(ctx, "POST", "/v1/me/password", {
          current_password: input.currentPassword,
          new_password: input.newPassword,
        }),
      );
    },

    async requestPasswordReset(
      ctx: CallContext,
      email: string,
    ): Promise<void> {
      await http.send(ctx, "POST", "/v1/auth/password/forgot", {
        body: JSON.stringify({ email }),
        contentType: "application/json",
      });
    },

    async resetPassword(
      ctx: CallContext,
      token: string,
      password: string,
    ): Promise<void> {
      await http.send(ctx, "POST", "/v1/auth/password/reset", {
        body: JSON.stringify({ token, new_password: password }),
        contentType: "application/json",
      });
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
    async list(ctx: CallContext, page?: Page): Promise<GeneratedDocument[]> {
      const body = await http.json<{ items: ApiDocument[] }>(
        ctx,
        "GET",
        `/v1/documents${pageQuery(page)}`,
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

function toSession(body: ApiSession): Session {
  return {
    accessToken: body.access_token,
    accessExpiresAt: new Date(body.expires_at),
    refreshToken: body.refresh_token,
    refreshExpiresAt: new Date(body.refresh_expires_at),
    user: toUser(body.user),
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
  };
}
