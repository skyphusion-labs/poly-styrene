import { chunkDiscord } from "./text";

export type OutFile = {
  filename: string;
  mime: string;
  bytes: Uint8Array;
};

function blobFrom(bytes: Uint8Array, mime: string): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: mime });
}

// The interaction token is the credential. It stays in the URL and out of errors.
async function sendDiscord(
  url: string,
  method: string,
  content: string,
  files: OutFile[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const headers: Record<string, string> = {};
  let body: BodyInit;
  if (files.length === 0) {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ content });
  } else {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));
    files.forEach((file, index) => {
      form.append(`files[${index}]`, blobFrom(file.bytes, file.mime), file.filename);
    });
    body = form;
  }
  const response = await fetchImpl(url, { method, headers, body });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Discord ${response.status}: ${detail}`);
  }
}

export async function postDiscordMessage(
  args: {
    applicationId: string;
    interactionToken: string;
    content: string;
    files?: OutFile[];
    followup: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = `https://discord.com/api/v10/webhooks/${args.applicationId}/${args.interactionToken}`;
  const url = args.followup ? base : `${base}/messages/@original`;
  const method = args.followup ? "POST" : "PATCH";
  await sendDiscord(url, method, args.content, args.files ?? [], fetchImpl);
}

export async function publishAnswer(
  args: {
    applicationId: string;
    interactionToken: string;
    text: string;
    files?: OutFile[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const chunks = chunkDiscord(args.text);
  for (let i = 0; i < chunks.length; i++) {
    await postDiscordMessage(
      {
        applicationId: args.applicationId,
        interactionToken: args.interactionToken,
        content: chunks[i] ?? "",
        files: i === 0 ? args.files : undefined,
        followup: i > 0,
      },
      fetchImpl,
    );
  }
}
