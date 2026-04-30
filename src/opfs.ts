import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

const ROOT_PATH = "/";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function normalizeSegments(path: string): string[] {
  const segments = path.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

export function normalizePath(path: string, cwd = ROOT_PATH): string {
  const absolute = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  const segments = normalizeSegments(absolute);
  return `/${segments.join("/")}`;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === ROOT_PATH) {
    return ROOT_PATH;
  }
  const parts = normalized.split("/");
  parts.pop();
  const result = parts.join("/");
  return result || ROOT_PATH;
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === ROOT_PATH) {
    return "";
  }
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? "";
}

function isDomException(error: unknown, names: string[]): boolean {
  return error instanceof DOMException && names.includes(error.name);
}

function toUint8Array(content: FileContent, encoding: BufferEncoding = "utf8"): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }

  switch (encoding) {
    case "utf8":
    case "utf-8":
    case "ascii":
      return textEncoder.encode(content);
    case "latin1":
    case "binary": {
      const bytes = new Uint8Array(content.length);
      for (let index = 0; index < content.length; index += 1) {
        bytes[index] = content.charCodeAt(index) & 0xff;
      }
      return bytes;
    }
    case "base64":
      return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
    case "hex": {
      const size = Math.floor(content.length / 2);
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        bytes[index] = Number.parseInt(content.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }
    default:
      return textEncoder.encode(content);
  }
}

function fromUint8Array(bytes: Uint8Array, encoding: BufferEncoding = "utf8"): string {
  switch (encoding) {
    case "utf8":
    case "utf-8":
    case "ascii":
      return textDecoder.decode(bytes);
    case "latin1":
    case "binary":
      return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
    case "base64":
      return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(""));
    case "hex":
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    default:
      return textDecoder.decode(bytes);
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index] ?? "";
    const next = pattern[index + 1];
    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      source += "[^/]*";
      continue;
    }
    if (current === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(current);
  }
  source += "$";
  return new RegExp(source);
}

export interface GrepOptions {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export class OpfsWorkspace implements IFileSystem {
  private readonly rootHandlePromise: Promise<FileSystemDirectoryHandle>;
  private readonly pathIndex = new Set<string>([ROOT_PATH]);
  private readyPromise: Promise<void> | undefined;

  public constructor() {
    this.rootHandlePromise = navigator.storage.getDirectory();
  }

  public async ready(): Promise<void> {
    this.readyPromise ??= this.refreshIndex();
    await this.readyPromise;
  }

  public resolvePath(base: string, path: string): string {
    return normalizePath(path, base);
  }

  public async readText(path: string): Promise<string> {
    return fromUint8Array(await this.readFileBuffer(path));
  }

  public async listAllPaths(): Promise<string[]> {
    await this.ready();
    return Array.from(this.pathIndex).sort();
  }

  public async renderTree(): Promise<string> {
    const lines: string[] = [];
    await this.walkDirectory(ROOT_PATH, async (currentPath, handle) => {
      if (currentPath === ROOT_PATH) {
        lines.push("/\n");
        return;
      }
      const depth = normalizeSegments(currentPath).length - 1;
      const prefix = `${"  ".repeat(Math.max(depth, 0))}${handle.kind === "directory" ? "📁" : "📄"}`;
      lines.push(`${prefix} ${basename(currentPath)}\n`);
    });
    return lines.join("");
  }

  public async clear(): Promise<void> {
    const root = await this.rootHandlePromise;
    const names: string[] = [];
    for await (const [name] of root.entries()) {
      names.push(name);
    }
    await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
    await this.refreshIndex();
  }

  public async findPaths(pattern: string, cwd = ROOT_PATH, limit = 200): Promise<string[]> {
    await this.ready();
    const normalizedBase = normalizePath(cwd);
    const relativePattern = pattern.includes("/") ? pattern : `**/${pattern}`;
    const matcher = globToRegExp(relativePattern);
    const results: string[] = [];

    for (const path of Array.from(this.pathIndex).sort()) {
      if (path === ROOT_PATH || path === normalizedBase) {
        continue;
      }
      if (!path.startsWith(normalizedBase === ROOT_PATH ? "/" : `${normalizedBase}/`)) {
        continue;
      }
      const relative = path.slice(normalizedBase === ROOT_PATH ? 1 : normalizedBase.length + 1);
      if (matcher.test(relative)) {
        results.push(path);
        if (results.length >= limit) {
          break;
        }
      }
    }

    return results;
  }

  public async grep(options: GrepOptions): Promise<string> {
    const basePath = normalizePath(options.path ?? ROOT_PATH);
    const filePaths = (await this.listAllPaths()).filter((path) => path !== ROOT_PATH && !path.endsWith("/"));
    const matcher = options.glob ? globToRegExp(options.glob.includes("/") ? options.glob : `**/${options.glob}`) : undefined;
    const flags = options.ignoreCase ? "gi" : "g";
    const expression = new RegExp(options.literal ? escapeRegExp(options.pattern) : options.pattern, flags);
    const contextRadius = Math.max(0, options.context ?? 0);
    const lines: string[] = [];
    let matchCount = 0;

    for (const filePath of filePaths) {
      if (!filePath.startsWith(basePath === ROOT_PATH ? "/" : `${basePath}/`) && filePath !== basePath) {
        continue;
      }
      const relative = filePath.slice(basePath === ROOT_PATH ? 1 : basePath.length + 1);
      if (matcher && !matcher.test(relative)) {
        continue;
      }

      const content = await this.readText(filePath);
      if (content.includes("\u0000")) {
        continue;
      }

      const fileLines = content.replace(/\r\n/g, "\n").split("\n");
      const emitted = new Set<number>();
      for (let index = 0; index < fileLines.length; index += 1) {
        expression.lastIndex = 0;
        if (!expression.test(fileLines[index] ?? "")) {
          continue;
        }
        const start = Math.max(0, index - contextRadius);
        const end = Math.min(fileLines.length - 1, index + contextRadius);
        for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
          if (emitted.has(lineIndex)) {
            continue;
          }
          emitted.add(lineIndex);
          const marker = lineIndex === index ? ":" : "-";
          lines.push(`${filePath}${marker}${lineIndex + 1}${marker}${fileLines[lineIndex] ?? ""}`);
        }
        matchCount += 1;
        if (matchCount >= (options.limit ?? 50)) {
          return lines.join("\n");
        }
      }
    }

    return lines.join("\n");
  }

  public async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const encoding = typeof options === "string" ? options : options?.encoding ?? "utf8";
    return fromUint8Array(await this.readFileBuffer(path), encoding ?? "utf8");
  }

  public async readFileBuffer(path: string): Promise<Uint8Array> {
    const handle = await this.getFileHandle(normalizePath(path));
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  public async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const normalized = normalizePath(path);
    const bytes = toUint8Array(content, typeof options === "string" ? options : options?.encoding ?? "utf8");
    const handle = await this.getFileHandle(normalized, true);
    const writable = await handle.createWritable({ keepExistingData: false });
    const writableBytes = new Uint8Array(bytes.byteLength);
    writableBytes.set(bytes);
    await writable.write(new Blob([writableBytes]));
    await writable.close();
    this.pathIndex.add(normalized);
    await this.addParentsToIndex(normalized);
  }

  public async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const normalized = normalizePath(path);
    const existing = (await this.exists(normalized)) ? await this.readFileBuffer(normalized) : new Uint8Array();
    const addition = toUint8Array(content, typeof options === "string" ? options : options?.encoding ?? "utf8");
    const combined = new Uint8Array(existing.length + addition.length);
    combined.set(existing);
    combined.set(addition, existing.length);
    await this.writeFile(normalized, combined);
  }

  public async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      return true;
    }
    try {
      await this.getFileHandle(normalized);
      return true;
    } catch (error) {
      if (!isDomException(error, ["NotFoundError", "TypeMismatchError"])) {
        throw error;
      }
    }

    try {
      await this.getDirectoryHandle(normalized);
      return true;
    } catch (error) {
      if (isDomException(error, ["NotFoundError", "TypeMismatchError"])) {
        return false;
      }
      throw error;
    }
  }

  public async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(),
      };
    }

    try {
      const handle = await this.getFileHandle(normalized);
      const file = await handle.getFile();
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: file.size,
        mtime: new Date(file.lastModified),
      };
    } catch (error) {
      if (!isDomException(error, ["NotFoundError", "TypeMismatchError"])) {
        throw error;
      }
    }

    await this.getDirectoryHandle(normalized);
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o755,
      size: 0,
      mtime: new Date(),
    };
  }

  public async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      return;
    }
    if (!options?.recursive) {
      const parent = dirname(normalized);
      if (!(await this.exists(parent))) {
        throw new Error(`Parent directory does not exist: ${parent}`);
      }
    }
    await this.getDirectoryHandle(normalized, true);
    await this.addParentsToIndex(normalized);
  }

  public async readdir(path: string): Promise<string[]> {
    const handle = await this.getDirectoryHandle(normalizePath(path));
    const names: string[] = [];
    for await (const [name] of handle.entries()) {
      names.push(name);
    }
    return names.sort();
  }

  public async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const handle = await this.getDirectoryHandle(normalizePath(path));
    const entries: DirentEntry[] = [];
    for await (const [name, child] of handle.entries()) {
      entries.push({
        name,
        isFile: child.kind === "file",
        isDirectory: child.kind === "directory",
        isSymbolicLink: false,
      });
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  public async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      if (!options?.recursive) {
        throw new Error("Removing / requires recursive: true");
      }
      await this.clear();
      return;
    }
    const parent = await this.getDirectoryHandle(dirname(normalized));
    try {
      await parent.removeEntry(basename(normalized), { recursive: options?.recursive });
      await this.refreshIndex();
    } catch (error) {
      if (options?.force && isDomException(error, ["NotFoundError"])) {
        return;
      }
      throw error;
    }
  }

  public async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const source = normalizePath(src);
    const target = normalizePath(dest);
    const sourceStat = await this.stat(source);
    if (sourceStat.isDirectory && !options?.recursive) {
      throw new Error(`Cannot copy directory without recursive option: ${source}`);
    }
    if (sourceStat.isDirectory) {
      await this.mkdir(target, { recursive: true });
      for (const name of await this.readdir(source)) {
        await this.cp(`${source}/${name}`, `${target}/${name}`, { recursive: true });
      }
      return;
    }
    await this.writeFile(target, await this.readFileBuffer(source));
  }

  public async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: false });
  }

  public getAllPaths(): string[] {
    return Array.from(this.pathIndex).sort();
  }

  public async chmod(): Promise<void> {}

  public async symlink(): Promise<void> {
    throw new Error("Symbolic links are not supported in OPFS.");
  }

  public async link(): Promise<void> {
    throw new Error("Hard links are not supported in OPFS.");
  }

  public async readlink(): Promise<string> {
    throw new Error("Symbolic links are not supported in OPFS.");
  }

  public async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  public async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (!(await this.exists(normalized))) {
      throw new Error(`Path does not exist: ${normalized}`);
    }
    return normalized;
  }

  public async utimes(): Promise<void> {}

  private async refreshIndex(): Promise<void> {
    this.pathIndex.clear();
    this.pathIndex.add(ROOT_PATH);
    await this.walkDirectory(ROOT_PATH, async (path) => {
      this.pathIndex.add(path);
    });
  }

  private async walkDirectory(
    startPath: string,
    visitor: (path: string, handle: FileSystemHandle) => Promise<void> | void,
  ): Promise<void> {
    const startHandle = await this.getDirectoryHandle(startPath);
    const visit = async (path: string, handle: FileSystemDirectoryHandle): Promise<void> => {
      for await (const [name, child] of handle.entries()) {
        const childPath = normalizePath(`${path}/${name}`);
        await visitor(childPath, child);
        if (child.kind === "directory") {
          await visit(childPath, child);
        }
      }
    };
    await visit(startPath, startHandle);
  }

  private async addParentsToIndex(path: string): Promise<void> {
    let current = dirname(path);
    while (true) {
      this.pathIndex.add(current);
      if (current === ROOT_PATH) {
        break;
      }
      current = dirname(current);
    }
  }

  private async getDirectoryHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const normalized = normalizePath(path);
    const segments = normalizeSegments(normalized);
    let handle = await this.rootHandlePromise;
    for (const segment of segments) {
      handle = await handle.getDirectoryHandle(segment, { create });
    }
    return handle;
  }

  private async getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const normalized = normalizePath(path);
    const parent = await this.getDirectoryHandle(dirname(normalized), create);
    const name = basename(normalized);
    if (!name) {
      throw new Error("Cannot open / as a file.");
    }
    return parent.getFileHandle(name, { create });
  }
}
