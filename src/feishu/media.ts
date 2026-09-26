import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** 飞书上传上限：图片 10 MB、文件 30 MB，超过平台会直接拒绝。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** push_image 只接受飞书能识别的图片后缀：错的后缀到平台才报错，本地先给出可读提示。 */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tif", ".tiff", ".heic"];

export type MediaKind = "image" | "file";

/**
 * 把用户给的路径变成绝对路径。终端侧必须用它：网关是常驻进程，工作目录与终端会话不同，
 * 相对路径只有在终端进程里才能按用户预期解析。
 */
export function resolveMediaPath(raw: string, cwd: string | undefined) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("需要媒体文件路径。");
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  if (isAbsolute(expanded)) return expanded;
  if (!cwd) throw new Error(`媒体路径必须写成绝对路径或 ~/ 开头：${trimmed}`);
  return resolve(cwd, expanded);
}

/** 校验待发送的本地文件并返回上传所需信息；path 必须已经是绝对路径。 */
export function describeMediaFile(filePath: string, kind: MediaKind) {
  if (!isAbsolute(filePath)) throw new Error(`媒体路径必须是绝对路径：${filePath}`);
  let info: Stats;
  try {
    info = statSync(filePath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new Error(`文件不存在：${filePath}`);
    throw new Error(`无法读取文件（${code || "未知错误"}）：${filePath}`);
  }
  if (!info.isFile()) throw new Error(`不是普通文件：${filePath}`);
  if (info.size === 0) throw new Error(`文件为空，无法发送：${filePath}`);
  const name = basename(filePath);
  const limitName = kind === "image" ? "图片" : "文件";
  if (info.size > (kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES))
    throw new Error(`${limitName}超过飞书 ${Math.floor((kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES) / 1024 / 1024)} MB 上限：${(info.size / 1024 / 1024).toFixed(1)} MB`);
  if (kind === "image" && !IMAGE_EXTENSIONS.includes(name.slice(name.lastIndexOf(".")).toLowerCase()))
    throw new Error(`不是图片（${name}）：只能发送 ${IMAGE_EXTENSIONS.join("、")}；其它文件请用 push_file。`);
  return { path: filePath, name, size: info.size };
}
