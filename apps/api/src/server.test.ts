import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHandler } from "./server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const directory = mkdtempSync(join(tmpdir(), "intake-api-"));
const uploadDir = join(directory, "uploads");
const databaseUrl = `file:${join(directory, "intake.db")}`;

const handlerPromise = Promise.resolve(
  makeHandler({
    port: 0,
    databaseUrl,
    uploadDir,
    webOrigin: "http://localhost:5173",
  }),
);

async function postForm(fields: Record<string, string | File>): Promise<Response> {
  const { handler } = await handlerPromise;
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.set(key, value);
  }
  return handler(
    new Request("http://localhost/api/submissions", {
      method: "POST",
      body,
    }),
  );
}

function validFields(image: File): Record<string, string | File> {
  return {
    firstName: " Ada ",
    lastName: "Lovelace",
    address: "12 Analytical Engine\nLondon",
    externalId: " rec_1001 ",
    image,
  };
}

beforeAll(async () => {
  await handlerPromise;
});

afterAll(async () => {
  const app = await handlerPromise;
  await app.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe("POST /api/submissions", () => {
  it("persists a row and the image file", async () => {
    const image = new File([PNG], "portrait.png", { type: "image/png" });
    const response = await postForm(validFields(image));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      firstName: string;
      externalId: string;
      status: string;
      image: { filename: string; mimeType: string; sizeBytes: number };
      createdAt: string;
      updatedAt: string;
    };

    expect(body.firstName).toBe("Ada");
    expect(body.externalId).toBe("rec_1001");
    expect(body.status).toBe("pending");
    expect(body.image).toMatchObject({
      filename: "portrait.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
    });
    expect(body.createdAt).toBe(body.updatedAt);

    const client = createClient({ url: databaseUrl });
    const rows = await client.execute({
      sql: "SELECT image_storage_path, status FROM submissions WHERE id = ?",
      args: [body.id],
    });
    client.close();
    const storedPath = rows.rows[0]?.image_storage_path;
    expect(typeof storedPath).toBe("string");
    expect(rows.rows[0]?.status).toBe("pending");
    if (typeof storedPath !== "string") {
      return;
    }
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath).equals(PNG)).toBe(true);

    const { handler } = await handlerPromise;
    const listed = await handler(new Request("http://localhost/api/submissions"));
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { submissions: Array<{ id: string }> };
    expect(listBody.submissions.some((submission) => submission.id === body.id)).toBe(true);

    const fetched = await handler(new Request(`http://localhost/api/submissions/${body.id}`));
    expect(fetched.status).toBe(200);

    const imageResponse = await handler(
      new Request(`http://localhost/api/submissions/${body.id}/image`),
    );
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await imageResponse.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("rejects an invalid external id and a non-image upload", async () => {
    const badId = await postForm({
      ...validFields(new File([PNG], "portrait.png", { type: "image/png" })),
      externalId: "not valid",
    });
    expect(badId.status).toBe(400);
    const badIdBody = (await badId.json()) as { error: string; fields?: Record<string, string> };
    expect(badIdBody.error).toBe("validation_error");
    expect(badIdBody.fields?.externalId).toBeTruthy();

    const badImage = await postForm(
      validFields(new File(["hello"], "notes.png", { type: "image/png" })),
    );
    expect(badImage.status).toBe(400);
    const badImageBody = (await badImage.json()) as { fields?: Record<string, string> };
    expect(badImageBody.fields?.image).toMatch(/JPEG, PNG, or WebP/);

    const client = createClient({ url: databaseUrl });
    const count = await client.execute("SELECT COUNT(*) AS count FROM submissions");
    client.close();
    expect(count.rows[0]?.count).toBe(1);
  });
});
