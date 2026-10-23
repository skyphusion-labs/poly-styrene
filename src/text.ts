export function selectValue(id: string): string {
  if (id.length <= 100) return id;
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash, 33) ^ id.charCodeAt(i);
  return "h:" + (hash >>> 0).toString(16).padStart(8, "0");
}

export function formatReply(modelId: string, body: string): string {
  const safeId = modelId.replaceAll("`", "");
  const cut = body.length > 8000;
  const clipped = cut ? body.slice(0, 8000) : body;
  const note = cut ? "\n\n(I cut this short to fit Discord.)" : "";
  return `Poly Styrene, \`${safeId}\`\n${clipped}${note}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/^data:[^,]*,/, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hardenLines(text: string, limit: number): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= limit) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
  }
  return out.join("\n");
}

// Discord messages cap at 2000 characters. A code fence that crosses a split
// is closed on this chunk and reopened on the next, or the fence breaks.
export function chunkDiscord(text: string, limit = 1900): string[] {
  const clean = hardenLines(text.replace(/\r\n/g, "\n").trim(), limit);
  if (!clean) return ["(The model returned nothing.)"];
  const chunks: string[] = [];
  let rest = clean;
  let open = false;
  while (rest.length > 0 && chunks.length < 12) {
    if (rest.length <= limit) {
      chunks.push(open ? "```\n" + rest : rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < 200) cut = limit;
    const raw = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    const marks = raw.split("```").length - 1;
    let piece = open ? "```\n" + raw : raw;
    if ((open ? 1 : 0) + (marks % 2) === 1) {
      piece += "\n```";
      open = true;
    } else {
      open = false;
    }
    chunks.push(piece);
  }
  if (rest.length > 0) chunks.push("(I stopped here. The rest was too long for Discord.)");
  return chunks;
}
