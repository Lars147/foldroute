import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", root), "utf8"),
);
const publicRoot = new URL("public/", root);
const files = (await readdir(publicRoot)).filter((name) =>
  name.endsWith("-LICENSE.txt"),
);
const notices = (
  await Promise.all(
    files.map((name) => readFile(new URL(name, publicRoot), "utf8")),
  )
).join("\n");
const normalize = (text) => text.replace(/\s+/g, " ").trim();
const normalized = normalize(notices);
const packages = Object.entries(lock.packages).filter(
  ([path, value]) => path && !value.dev,
);
const failures = [];

for (const [path, pkg] of packages) {
  const name = path.split("node_modules/").at(-1);
  const label = `${name} ${pkg.version}`;
  if (
    !notices
      .split("\n")
      .some((line) => line === label || line.startsWith(`${label} (`))
  )
    failures.push(
      `${label}: package/version missing from public license notices`,
    );

  const packageRoot = new URL(`${path}/`, root);
  const originals = (
    await readdir(packageRoot, { withFileTypes: true })
  ).filter(
    (entry) =>
      entry.isFile() &&
      /^(licen[cs]e|copying|notice)(\.|$|[-_])/i.test(entry.name),
  );
  for (const original of originals) {
    const text = await readFile(new URL(original.name, packageRoot), "utf8");
    if (!normalized.includes(normalize(text)))
      failures.push(
        `${label}: ${original.name} missing from public license notices`,
      );
  }
}

const workbox = await readFile(
  new URL("node_modules/workbox-core/LICENSE", root),
  "utf8",
);
if (!normalized.includes(normalize(workbox)))
  failures.push(
    "Workbox: original license missing from public license notices",
  );

if (failures.length)
  throw new Error(`Incomplete third-party notices:\n${failures.join("\n")}`);

console.log(
  `License notices cover ${packages.length} production packages and Workbox.`,
);
