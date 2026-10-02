/** Subscription-only login using the SDK shipped with the user's Pi install. */
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

export async function piRuntime(executable) {
  let folder = dirname(await realpath(executable));
  while (folder !== dirname(folder)) {
    try {
      const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
      if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(pkg.name)) {
        const { ModelRuntime } = await import(pathToFileURL(join(folder, "dist", "index.js")).href);
        if (!ModelRuntime) throw new Error("Update Pi to the latest version to connect a subscription.");
        return ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    folder = dirname(folder);
  }
  throw new Error("Could not find Pi's SDK. Install the official Pi npm package and retry.");
}

export async function loginPiSubscription(runtime, io) {
  const providers = runtime.getProviders().filter((provider) => provider.auth?.oauth?.isSubscription === true);
  if (!providers.length) throw new Error("This Pi version has no subscription sign-in providers. Update Pi and retry.");
  const ask = async (prompt) => {
    if (prompt.type === "select") {
      prompt.options.forEach((option, index) => io.notify(`${index + 1}. ${option.label}`));
      while (true) {
        const answer = await io.prompt(`${prompt.message} (1–${prompt.options.length}): `, prompt.signal);
        const index = /^\d+$/.test(answer.trim()) ? Number(answer) - 1 : -1;
        if (prompt.options[index]) return prompt.options[index].id;
        io.notify("Choose one of the numbers above.");
      }
    }
    return io.prompt(`${prompt.message}: `, prompt.signal);
  };
  const provider = await ask({ type: "select", message: "Choose your subscription", options: providers.map((entry) => ({ id: entry.id, label: entry.auth.oauth.name })) });
  await runtime.login(provider, "oauth", {
    prompt: ask,
    notify: (event) => {
      if (event.type === "auth_url") io.notify(`${event.instructions || "Open this sign-in page:"}\n${event.url}`);
      else if (event.type === "device_code") io.notify(`Open ${event.verificationUri}\nCode: ${event.userCode}`);
      else if (event.message) io.notify(event.message);
    },
  });
  io.notify("Subscription connected. You can return to DevDen.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const runtime = await piRuntime(process.argv[2]);
    await loginPiSubscription(runtime, {
      prompt: (message, signal) => readline.question(message, { signal }),
      notify: (message) => console.log(message),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    readline.close();
  }
}
