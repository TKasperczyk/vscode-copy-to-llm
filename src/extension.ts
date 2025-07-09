"use strict";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Minimatch } from "minimatch";

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "extension.copyToLLM",
    async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      // If no parameters provided (hotkey usage), get explorer selection
      if (!uri && (!selectedUris || selectedUris.length === 0)) {
        selectedUris = await getExplorerSelection();
        if (!selectedUris || selectedUris.length === 0) {
          vscode.window.showWarningMessage(
            "Please select files in the Explorer first"
          );
          return;
        }
      }

      if (selectedUris && selectedUris.length > 0) {
        copySelectedToLLM(selectedUris);
      } else if (uri && uri.scheme === "file") {
        const stats = fs.statSync(uri.fsPath);
        if (stats.isDirectory()) {
          copyFolderToLLM([uri]);
        } else if (stats.isFile()) {
          copyFileToClipboard(uri.fsPath);
        }
      }
    }
  );
  context.subscriptions.push(disposable);
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
  const directories = uris.filter((uri) =>
    fs.statSync(uri.fsPath).isDirectory()
  );
  const files = uris.filter((uri) => fs.statSync(uri.fsPath).isFile());

  let content = "";

  // Process directories
  for (const dir of directories) {
    const dirFiles = await getFilesByExtensions(dir.fsPath);
    content += await generateContent(dir.fsPath, dirFiles);
  }

  // Process individual files
  for (const file of files) {
    const fileContent = await fs.promises.readFile(file.fsPath, "utf-8");
    const label = getDisplayPath(file.fsPath);
    content += `${label}:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
  }

  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Content copied to clipboard");

  const document = await vscode.workspace.openTextDocument({
    content: content,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document);
}

async function copyFolderToLLM(uris: vscode.Uri[]) {
  let content = "";
  for (const uri of uris) {
    const files = await getFilesByExtensions(uri.fsPath);
    content += await generateContent(uri.fsPath, files);
  }

  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Content copied to clipboard");

  const document = await vscode.workspace.openTextDocument({
    content: content,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document);
}

async function copyFileToClipboard(filePath: string) {
  const fileContent = await fs.promises.readFile(filePath, "utf-8");
  const label = getDisplayPath(filePath);
  const content = `${label}:\n\`\`\`\n${fileContent}\n\`\`\``;
  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Content copied to clipboard");
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
      } else if (entry.isFile() && !fullPath.includes("shadcn")) {
        const fileExtension = path.extname(entry.name);
        if (extensions.includes(fileExtension)) {
          files.push(fullPath);
        }
      }
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
    const fileContent = await fs.promises.readFile(file, "utf-8");
    const label = getDisplayPath(file, basePath);
    content += `${label}:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
  }
  return content;
}

function getDisplayPath(filePath: string, basePathOverride?: string): string {
  const config = vscode.workspace.getConfiguration("copyToLLM");
  const useRelative = config.get<boolean>("useRelativePaths", false);
  if (useRelative) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (wsFolder) {
      // ruta relativa al workspace root, con slashes Unix
      return path.relative(wsFolder, filePath).replace(/\\/g, "/");
    }
  }
  // comportamiento por defecto: mismo que antes
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

export function deactivate() {}
