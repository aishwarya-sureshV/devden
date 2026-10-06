import {
  MATERIAL_ICONS,
  getIconForDirectoryPath,
  getIconForFilePath,
  isMaterialIconName,
} from "vscode-material-icons";

// SVGs are copied from node_modules/vscode-material-icons/generated/icons.
const BASE = `${import.meta.env.BASE_URL}file-icons/`;
const FILE_POOL = MATERIAL_ICONS.filter((n) => !n.startsWith("folder"));
const FOLDER_POOL = MATERIAL_ICONS.filter(
  (n) => n.startsWith("folder-") && !n.endsWith("-open"),
);

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Pack icon when the name is recognised; otherwise a stable pick from the
 *  whole pool, so unknown files and plain folders don't all look the same. */
export function materialIconName(name: string, isDirectory: boolean, open = false) {
  let icon: string = isDirectory ? getIconForDirectoryPath(name) : getIconForFilePath(name);
  if (icon === "file" || icon === "folder") {
    const pool = isDirectory ? FOLDER_POOL : FILE_POOL;
    icon = pool[hash(name) % pool.length];
  }
  if (isDirectory && open && isMaterialIconName(`${icon}-open`)) icon = `${icon}-open`;
  return icon;
}

export function MaterialIcon({ name, isDirectory = false, open = false }: { name: string; isDirectory?: boolean; open?: boolean }) {
  return (
    <img
      className="material-icon"
      src={`${BASE}${materialIconName(name, isDirectory, open)}.svg`}
      width={16}
      height={16}
      alt=""
      draggable={false}
    />
  );
}
