"use strict";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Minimatch } from "minimatch";
import { execFile } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";

const execFileAsync = promisify(execFile);

// RTK concurrency limit (8 parallel processes)
const rtkLimit = pLimit(8);

// RTK availability flag (checked once per session)
let rtkAvailable: boolean | null = null;

/**
 * Check if RTK binary is installed
 */
async function isRtkInstalled(): Promise<boolean> {
  if (rtkAvailable !== null) {
    return rtkAvailable;
  }
  try {
    await execFileAsync("rtk", ["--version"]);
    rtkAvailable = true;
    return true;
  } catch {
    rtkAvailable = false;
    return false;
  }
}

/**
 * Read a file through RTK for compressed output
 */
async function rtkReadFile(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("rtk", ["read", filePath], {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      timeout: 30000, // 30 second timeout
    });
    return stdout;
  } catch (err: any) {
    console.warn(`RTK failed for ${filePath}: ${err.message}`);
    // Fallback to raw read
    return fs.promises.readFile(filePath, "utf-8");
  }
}

/**
 * Generate compressed content using RTK with parallel execution
 */
async function generateCompressedContent(files: string[]): Promise<string> {
  const results = await Promise.all(
    files.map((file) =>
      rtkLimit(async () => {
        try {
          const compressed = await rtkReadFile(file);
          const absolutePath = file.replace(/\\/g, "/");
          return `<file src="${absolutePath}">\n${compressed}</file>`;
        } catch (err: any) {
          console.warn(`Failed to process ${file}: ${err.message}`);
          return null;
        }
      })
    )
  );

  const validResults = results.filter(Boolean).join("\n\n");
  return `<context compressed="true">\n${validResults}\n</context>`;
}

/**
 * Generate XML-tagged content (no RTK compression) with parallel execution
 */
async function generateXmlContent(files: string[]): Promise<string> {
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const fileContent = await fs.promises.readFile(file, "utf-8");
        const absolutePath = file.replace(/\\/g, "/");
        return `<file src="${absolutePath}">\n${fileContent}</file>`;
      } catch (err: any) {
        console.warn(`Failed to process ${file}: ${err.message}`);
        return null;
      }
    })
  );

  const validResults = results.filter(Boolean).join("\n\n");
  return `<context>\n${validResults}\n</context>`;
}

/**
 * Safely execute a git command with proper argument handling (no shell injection)
 */
async function gitCommand(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  } catch (err: any) {
    // If git command fails, return empty string (e.g., no diff)
    if (err.stdout !== undefined) {
      return err.stdout;
    }
    throw err;
  }
}

/**
 * Parse git submodule status output into structured data
 */
function parseSubmoduleStatus(stdout: string, workspaceRoot: string): { name: string; path: string }[] {
  return stdout.split('\n')
    .filter(line => line.trim())
    .map(line => {
      // Match git submodule status line: [+-]<sha> <path> (<branch>)
      const match = line.match(/^\s*[+-]?([a-f0-9]+)\s+(.+?)(?:\s+\(.+\))?$/);
      if (match) {
        const submodulePath = path.resolve(workspaceRoot, match[2]);
        const submoduleName = path.basename(match[2]);
        return { name: submoduleName, path: submodulePath };
      }
      return null;
    })
    .filter((item): item is { name: string; path: string } => item !== null);
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "extension.copyToLLM",
    async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      // If no parameters provided (hotkey usage), get explorer selection
      if (!uri && (!selectedUris || selectedUris.length === 0)) {
        selectedUris = await getExplorerSelection();
        if (!selectedUris || selectedUris.length === 0) {
          const active = vscode.window.activeTextEditor;
          if (active) {
            await copyFileToClipboard(active.document.fileName);
            return;
          }
          vscode.window.showWarningMessage(
            "Please select files in the Explorer first"
          );
          return;
        }
      }

      if (selectedUris && selectedUris.length > 0) {
        await copySelectedToLLM(selectedUris);
      } else if (uri && uri.scheme === "file") {
        try {
          const stats = fs.statSync(uri.fsPath);
          if (stats.isDirectory()) {
            await copyFolderToLLM([uri]);
          } else if (stats.isFile()) {
            await copyFileToClipboard(uri.fsPath);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Cannot access path: ${err.message}`);
        }
      }
    }
  );
  context.subscriptions.push(disposable);

  const copySel = vscode.commands.registerCommand(
    "extension.copySelectionToLLM",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor");
        return;
      }
      if (editor.selections.every((sel: vscode.Selection) => sel.isEmpty)) {
        vscode.window.showWarningMessage("Select text first");
        return;
      }

      const doc = editor.document;
      const langId = doc.languageId || "";
      const filePath = getDisplayPath(doc.fileName);

      const blocks = editor.selections.map((sel: vscode.Selection) => {
        const text = doc.getText(sel);
        const lines = `${sel.start.line + 1}-${sel.end.line + 1}`;
        return `${filePath}:${lines}\n\`\`\`${langId}\n${text}\n\`\`\``;
      });

      const content = blocks.join("\n\n");
      await vscode.env.clipboard.writeText(content);
      vscode.window.showInformationMessage("Selection copied to clipboard");
      await showPreview(content);
    }
  );
  context.subscriptions.push(copySel);

  const copyDiff = vscode.commands.registerCommand(
    "extension.copyDiffToLLM",
    async (...args: any[]) => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsFolder) {
        vscode.window.showWarningMessage("No open workspace - nothing to diff.");
        return;
      }

      // Collect paths from SCM list to resource/resourceUri
      const flattened = args.length === 1 && Array.isArray(args[0])
        ? args[0]
        : args;
      const picked = flattened
        .map((r: any) => (r?.resourceUri ?? r)?.fsPath)
        .filter(Boolean);

      let allDiffs: string[] = [];

      try {
        if (picked.length > 0) {
          // Handle specific files/paths, including submodules
          for (const filePath of picked) {
            const relativePath = path.relative(wsFolder, filePath);

            // Check if this file is in a submodule
            const submoduleInfo = await getSubmoduleInfo(wsFolder, filePath);

            if (submoduleInfo) {
              // Handle submodule file
              const submoduleRelativePath = path.relative(submoduleInfo.path, filePath);

              try {
                const stdout = await gitCommand(
                  ["diff", "HEAD", "--", submoduleRelativePath],
                  submoduleInfo.path
                );

                if (stdout.trim()) {
                  allDiffs.push(`# Submodule: ${submoduleInfo.name}\n${stdout}`);
                }
              } catch {
                // Try unstaged changes in submodule
                try {
                  const unstagedDiff = await gitCommand(
                    ["diff", "--", submoduleRelativePath],
                    submoduleInfo.path
                  );

                  if (unstagedDiff.trim()) {
                    allDiffs.push(`# Submodule: ${submoduleInfo.name} (unstaged)\n${unstagedDiff}`);
                  }
                } catch {
                  // Silently ignore - file may not have changes
                }
              }
            } else {
              // Handle regular file
              try {
                const stdout = await gitCommand(
                  ["diff", "HEAD", "--", relativePath],
                  wsFolder
                );

                if (stdout.trim()) {
                  allDiffs.push(stdout);
                } else {
                  // Try unstaged changes
                  const unstagedDiff = await gitCommand(
                    ["diff", "--", relativePath],
                    wsFolder
                  );

                  if (unstagedDiff.trim()) {
                    allDiffs.push(unstagedDiff);
                  }
                }
              } catch {
                // Silently ignore - file may not have changes
              }
            }
          }
        } else {
          // No specific files selected, get all changes including submodules
          // Get main repository changes
          try {
            const mainDiff = await gitCommand(["diff", "HEAD"], wsFolder);

            if (mainDiff.trim()) {
              allDiffs.push(mainDiff);
            } else {
              // Try unstaged changes
              const unstagedDiff = await gitCommand(["diff"], wsFolder);

              if (unstagedDiff.trim()) {
                allDiffs.push(unstagedDiff);
              }
            }
          } catch {
            // Silently ignore - repo may not have changes
          }

          // Get submodule changes
          const submodules = await getSubmodules(wsFolder);
          for (const submodule of submodules) {
            try {
              const subDiff = await gitCommand(["diff", "HEAD"], submodule.path);

              if (subDiff.trim()) {
                allDiffs.push(`# Submodule: ${submodule.name}\n${subDiff}`);
              } else {
                // Try unstaged changes in submodule
                const unstagedSubDiff = await gitCommand(["diff"], submodule.path);

                if (unstagedSubDiff.trim()) {
                  allDiffs.push(`# Submodule: ${submodule.name} (unstaged)\n${unstagedSubDiff}`);
                }
              }
            } catch {
              // Silently ignore - submodule may not have changes
            }
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Git diff failed: ${err.message ?? err}`
        );
        return;
      }

      if (allDiffs.length === 0) {
        vscode.window.showInformationMessage("No changes to diff.");
        return;
      }

      // Combine all diffs
      const combinedDiff = allDiffs.join("\n\n");
      const content = "```diff\n" + combinedDiff + "\n```";

      await vscode.env.clipboard.writeText(content);
      vscode.window.showInformationMessage("Git diff copied to clipboard.");
      await showPreview(content);
    }
  );
  context.subscriptions.push(copyDiff);

  // RTK Compressed Copy command
  const copyCompressed = vscode.commands.registerCommand(
    "extension.copyCompressedToLLM",
    async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      // Check RTK availability first
      if (!(await isRtkInstalled())) {
        vscode.window.showWarningMessage(
          "RTK not found. Using full content instead; Refer to installation steps in https://github.com/rtk-ai/rtk#installation"
        );
        // Fallback to regular copy
        await vscode.commands.executeCommand("extension.copyToLLM", uri, selectedUris);
        return;
      }

      // If no parameters provided (hotkey usage), get explorer selection
      if (!uri && (!selectedUris || selectedUris.length === 0)) {
        selectedUris = await getExplorerSelection();
        if (!selectedUris || selectedUris.length === 0) {
          const active = vscode.window.activeTextEditor;
          if (active) {
            await copyCompressedFileToClipboard(active.document.fileName);
            return;
          }
          vscode.window.showWarningMessage(
            "Please select files in the Explorer first"
          );
          return;
        }
      }

      if (selectedUris && selectedUris.length > 0) {
        await copyCompressedSelectedToLLM(selectedUris);
      } else if (uri && uri.scheme === "file") {
        try {
          const stats = fs.statSync(uri.fsPath);
          if (stats.isDirectory()) {
            await copyCompressedFolderToLLM([uri]);
          } else if (stats.isFile()) {
            await copyCompressedFileToClipboard(uri.fsPath);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Cannot access path: ${err.message}`);
        }
      }
    }
  );
  context.subscriptions.push(copyCompressed);
}

// Helper function to get submodule information for a given file path
async function getSubmoduleInfo(workspaceRoot: string, filePath: string): Promise<{ name: string; path: string } | null> {
  try {
    const stdout = await gitCommand(["submodule", "status", "--recursive"], workspaceRoot);
    const submodules = parseSubmoduleStatus(stdout, workspaceRoot);

    // Check if the file path is within any submodule
    for (const submodule of submodules) {
      if (filePath.startsWith(submodule.path + path.sep) || filePath === submodule.path) {
        return submodule;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Helper function to get all submodules
async function getSubmodules(workspaceRoot: string): Promise<{ name: string; path: string }[]> {
  try {
    const stdout = await gitCommand(["submodule", "status", "--recursive"], workspaceRoot);
    return parseSubmoduleStatus(stdout, workspaceRoot);
  } catch {
    return [];
  }
}

async function getExplorerSelection(): Promise<vscode.Uri[] | undefined> {
  try {
    // Store current clipboard content to restore later
    const originalClipboard = await vscode.env.clipboard.readText();

    // Execute copy file path command to get selected files
    await vscode.commands.executeCommand("copyFilePath");
    const clipboardContent = await vscode.env.clipboard.readText();

    // Restore original clipboard content
    await vscode.env.clipboard.writeText(originalClipboard);

    if (clipboardContent && clipboardContent !== originalClipboard) {
      // Parse the clipboard content to get file paths
      const paths = clipboardContent
        .split("\n")
        .map((pathStr: string) => pathStr.trim())
        .filter((pathStr: string) => pathStr.length > 0);

      return paths.map((pathStr: string) => vscode.Uri.file(pathStr));
    }

    return undefined;
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error getting explorer selection: ${error}`
    );
    return undefined;
  }
}

async function copySelectedToLLM(uris: vscode.Uri[]) {
  const allFiles: string[] = [];

  for (const uri of uris) {
    try {
      const stats = fs.statSync(uri.fsPath);
      if (stats.isDirectory()) {
        const dirFiles = await getFilesByExtensions(uri.fsPath);
        allFiles.push(...dirFiles);
      } else if (stats.isFile()) {
        allFiles.push(uri.fsPath);
      }
    } catch {
      // Skip inaccessible paths
    }
  }

  if (allFiles.length === 0) {
    vscode.window.showWarningMessage("No files to copy");
    return;
  }

  const content = await generateXmlContent(allFiles);
  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Content copied to clipboard");

  await showPreview(content);
}

async function copyFolderToLLM(uris: vscode.Uri[]) {
  const allFiles: string[] = [];

  for (const uri of uris) {
    const files = await getFilesByExtensions(uri.fsPath);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    vscode.window.showWarningMessage("No files to copy");
    return;
  }

  const content = await generateXmlContent(allFiles);
  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Content copied to clipboard");

  await showPreview(content);
}

async function copyFileToClipboard(filePath: string) {
  try {
    const content = await generateXmlContent([filePath]);
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage("Content copied to clipboard");
  } catch (err: any) {
    vscode.window.showErrorMessage(`Cannot read file: ${err.message}`);
  }
}

async function getFilesByExtensions(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  const config = vscode.workspace.getConfiguration("copyToLLM");
  const extensions = config.get<string[]>("extensions", [
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".html",
    ".htm",
    ".xml",
    ".ejs",
    ".pug",
    ".jade",
    ".twig",
    ".erb",
    ".mustache",
    ".latte",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".styl",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".env",
    ".md",
    ".markdown",
    ".txt",
    ".ex",
    ".exs",
    ".heex",
    ".leex",
    ".eex",
    ".vue",
    ".svelte",
    ".astro",
    ".py",
    ".rb",
    ".php",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".go",
    ".rs",
    ".swift",
    ".kt",
    ".kts",
    ".dart",
    ".sql",
    ".sh",
    ".bat",
    ".ps1",
    ".csv",
    ".tsv",
    ".cfg",
    ".conf",
    ".properties",
    ".ics",
  ]);
  const ignorePatterns = config.get<string[]>("ignore", []);
  const minimatchers = ignorePatterns.map(pattern => new Minimatch(pattern, { dot: true }));

  async function traverse(currentPath: string) {
    try {
      const entries = await fs.promises.readdir(currentPath, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(dirPath, fullPath);

        let isIgnored = false;
        for (const matcher of minimatchers) {
          if (matcher.match(relativePath)) {
            isIgnored = true;
            break;
          }
        }
        if (isIgnored) {
          continue;
        }

        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (entry.isFile()) {
          const fileExtension = path.extname(entry.name);
          if (extensions.includes(fileExtension)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }
  await traverse(dirPath);
  return files;
}

async function generateContent(
  basePath: string,
  files: string[]
): Promise<string> {
  let content = "";
  for (const file of files) {
    try {
      const fileContent = await fs.promises.readFile(file, "utf-8");
      const label = getDisplayPath(file, basePath);
      content += `${label}:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
    } catch {
      // Skip unreadable files
    }
  }
  return content;
}

function getDisplayPath(filePath: string, basePathOverride?: string): string {
  const config = vscode.workspace.getConfiguration("copyToLLM");
  const useRelative = config.get<boolean>("useRelativePaths", false);
  if (useRelative) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsFolder) {
      // Return path relative to workspace root, with Unix-style slashes
      return path.relative(wsFolder, filePath).replace(/\\/g, "/");
    }
  }
  // Default behavior: same as before
  if (basePathOverride) {
    const relativeToBase = path
      .relative(basePathOverride, filePath)
      .replace(/\\/g, "/");
    const baseName = path.basename(basePathOverride);
    return `${baseName}/${relativeToBase}`;
  } else {
    return path.basename(filePath);
  }
}

async function showPreview(content: string) {
  const show = vscode.workspace
    .getConfiguration("copyToLLM")
    .get<boolean>("showPreview", true);

  if (!show) {
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    content: content,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document);
}

/**
 * Copy compressed content for selected files/folders
 */
async function copyCompressedSelectedToLLM(uris: vscode.Uri[]) {
  const allFiles: string[] = [];

  for (const uri of uris) {
    try {
      const stats = fs.statSync(uri.fsPath);
      if (stats.isDirectory()) {
        const dirFiles = await getFilesByExtensions(uri.fsPath);
        allFiles.push(...dirFiles);
      } else if (stats.isFile()) {
        allFiles.push(uri.fsPath);
      }
    } catch {
      // Skip inaccessible paths
    }
  }

  if (allFiles.length === 0) {
    vscode.window.showWarningMessage("No files to copy");
    return;
  }

  const content = await generateCompressedContent(allFiles);
  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage(
    `Compressed ${allFiles.length} file(s) to clipboard`
  );
  await showPreview(content);
}

/**
 * Copy compressed content for folders
 */
async function copyCompressedFolderToLLM(uris: vscode.Uri[]) {
  const allFiles: string[] = [];

  for (const uri of uris) {
    const files = await getFilesByExtensions(uri.fsPath);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    vscode.window.showWarningMessage("No files to copy");
    return;
  }

  const content = await generateCompressedContent(allFiles);
  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage(
    `Compressed ${allFiles.length} file(s) to clipboard`
  );
  await showPreview(content);
}

/**
 * Copy compressed content for a single file
 */
async function copyCompressedFileToClipboard(filePath: string) {
  try {
    const content = await generateCompressedContent([filePath]);
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage("Compressed content copied to clipboard");
    await showPreview(content);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Cannot read file: ${err.message}`);
  }
}

export function deactivate() { }