import { readFile } from "node:fs/promises";

const token = process.env.DISCORD_BOT_TOKEN ?? "";
const app = process.env.DISCORD_APPLICATION_ID ?? "";
const guild = process.env.DISCORD_GUILD_ID ?? "";

if (!token || !app) {
  console.error("Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID. Neither is printed.");
  process.exit(1);
}

const commands = JSON.parse(await readFile(new URL("../discord/commands.json", import.meta.url), "utf8"));
const path = guild
  ? `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`
  : `https://discord.com/api/v10/applications/${app}/commands`;

const response = await fetch(path, {
  method: "PUT",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  const detail = (await response.text()).slice(0, 300);
  console.error(`Discord ${response.status}: ${detail}`);
  process.exit(1);
}

const body = await response.json();
const count = Array.isArray(body) ? body.length : 0;
console.log(guild ? `registered ${count} guild commands` : `registered ${count} global commands`);
