"use strict";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Minimatch } from "minimatch";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
      const filePath = getDisplayPath(doc.fileName); // helper already defined

      const blocks = editor.selections.map((sel: vscode.Selection) => {
        const text = doc.getText(sel);
        const lines = `${sel.start.line + 1}-${sel.end.line + 1}`;
        return `${filePath}:${lines}\n\`\`\`${langId}\n${text}\n\`\`\``;
      });

      const content = blocks.join("\n\n");
      await vscode.env.clipboard.writeText(content);
      vscode.window.showInformationMessage("Selection copied to clipboard");
      await ShowPreview(content);
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
                const { stdout } = await execAsync(
                  `git diff HEAD -- "${submoduleRelativePath}"`,
                  { cwd: submoduleInfo.path }
                );
                
                if (stdout.trim()) {
                  allDiffs.push(`# Submodule: ${submoduleInfo.name}\n${stdout}`);
                }
              } catch (subErr: any) {
                // Try unstaged changes in submodule
                try {
                  const { stdout: unstagedDiff } = await execAsync(
                    `git diff -- "${submoduleRelativePath}"`,
                    { cwd: submoduleInfo.path }
                  );
                  
                  if (unstagedDiff.trim()) {
                    allDiffs.push(`# Submodule: ${submoduleInfo.name} (unstaged)\n${unstagedDiff}`);
                  }
                } catch {
                  console.warn(`Could not get diff for submodule file: ${filePath}`);
                }
              }
            } else {
              // Handle regular file
              try {
                const { stdout } = await execAsync(
                  `git diff HEAD -- "${relativePath}"`,
                  { cwd: wsFolder }
                );
                
                if (stdout.trim()) {
                  allDiffs.push(stdout);
                } else {
                  // Try unstaged changes
                  const { stdout: unstagedDiff } = await execAsync(
                    `git diff -- "${relativePath}"`,
                    { cwd: wsFolder }
                  );
                  
                  if (unstagedDiff.trim()) {
                    allDiffs.push(unstagedDiff);
                  }
                }
              } catch (err: any) {
                console.warn(`Could not get diff for file: ${filePath}`, err);
              }
            }
          }
        } else {
          // No specific files selected, get all changes including submodules
          // Get main repository changes
          try {
            const { stdout: mainDiff } = await execAsync(
              "git diff HEAD",
              { cwd: wsFolder }
            );
          
            if (mainDiff.trim()) {
              allDiffs.push(mainDiff);
            } else {
              // Try unstaged changes
              const { stdout: unstagedDiff } = await execAsync(
                "git diff",
                { cwd: wsFolder }
              );
            
              if (unstagedDiff.trim()) {
                allDiffs.push(unstagedDiff);
              }
            }
          } catch (err: any) {
            console.warn("Could not get main repository diff:", err);
          }

          // Get submodule changes
          const submodules = await getSubmodules(wsFolder);
          for (const submodule of submodules) {
            try {
              const { stdout: subDiff } = await execAsync(
                "git diff HEAD",
                { cwd: submodule.path }
              );
              
              if (subDiff.trim()) {
                allDiffs.push(`# Submodule: ${submodule.name}\n${subDiff}`);
              } else {
                // Try unstaged changes in submodule
                const { stdout: unstagedSubDiff } = await execAsync(
                  "git diff",
                  { cwd: submodule.path }
                );
                
                if (unstagedSubDiff.trim()) {
                  allDiffs.push(`# Submodule: ${submodule.name} (unstaged)\n${unstagedSubDiff}`);
                }
              }
            } catch (err: any) {
              console.warn(`Could not get diff for submodule ${submodule.name}:`, err);
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
        await ShowPreview(content);
      }
  );
  context.subscriptions.push(copyDiff);
}

// Helper function to get submodule information for a given file path
async function getSubmoduleInfo(workspaceRoot: string, filePath: string): Promise<{ name: string; path: string } | null> {
  try {
    const { stdout } = await execAsync(
      "git submodule status --recursive",
      { cwd: workspaceRoot }
    );
    
    const submodules = stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        // Match a git submodule status line for example 1e2d3f4 libs/foo (heads/main)
        //   ^\s*[+-]?            optional whitespace plus optional + or - status flag
        //   ([a-f0-9]+)          capture: abbreviated (or full) commit SHA
        //   \s+                  at least one space
        //   (.+?)                capture: sub-module path
        //   (?:\s+\(.+\))?       optional branch/tag info in parentheses
        //   $                    end of line
        const match = line.match(/^\s*[+-]?([a-f0-9]+)\s+(.+?)(?:\s+\(.+\))?$/);
        if (match) {
          const submodulePath = path.resolve(workspaceRoot, match[2]);
          const submoduleName = path.basename(match[2]);
          return { name: submoduleName, path: submodulePath };
        }
        return null;
      })
      .filter(Boolean) as { name: string; path: string }[];

    // Check if the file path is within any submodule
    for (const submodule of submodules) {
      if (filePath.startsWith(submodule.path + path.sep) || filePath === submodule.path) {
        return submodule;
      }
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

// Helper function to get all submodules
async function getSubmodules(workspaceRoot: string): Promise<{ name: string; path: string }[]> {
  try {
    const { stdout } = await execAsync(
      "git submodule status --recursive",
      { cwd: workspaceRoot }
    );
    
    return stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const match = line.match(/^\s*[+-]?([a-f0-9]+)\s+(.+?)(?:\s+\(.+\))?$/);
        if (match) {
          const submodulePath = path.resolve(workspaceRoot, match[2]);
          const submoduleName = path.basename(match[2]);
          return { name: submoduleName, path: submodulePath };
        }
        return null;
      })
      .filter(Boolean) as { name: string; path: string }[];
  } catch (err) {
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

  await ShowPreview(content);
}

async function copyFolderToLLM(uris: vscode.Uri[]) {
  let content = "";
  for (const uri of uris) {
    const files = await getFilesByExtensions(uri.fsPath);
    content += await generateContent(uri.fsPath, files);
  }

  await vscode.env.clipboard.writeText(content);
  vscode.window.showInformationMessage("Content copied to clipboard");

  await ShowPreview(content);
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

async function ShowPreview(content: string) {
  let show = vscode.workspace
    .getConfiguration("copyToLLM")
    .get<boolean>("showPreview", true);

  if (!show)
    return;

  const document = await vscode.workspace.openTextDocument({
    content: content,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document);
}

export function deactivate() { }