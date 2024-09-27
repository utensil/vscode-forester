import * as vscode from 'vscode';
import {load} from 'js-toml';
import * as util from 'util';
import * as server from './server';
import { readFile } from 'fs/promises';
import { join } from 'path';

// TODO there must be a better system
// Maybe an event pool instead of a promise
var cachedQuery : Promise<{[id: string]: server.QueryResult}>;
var cancel : vscode.CancellationTokenSource | undefined;
var dirty = true;

function getRoot() {
  if (vscode.workspace.workspaceFolders?.length) {
    if (vscode.workspace.workspaceFolders.length !== 1) {
      vscode.window.showWarningMessage("vscode-forester only supports opening one workspace folder.");
    }
    return vscode.workspace.workspaceFolders[0].uri;
  } else {
    // Probably opened a single file
    throw new vscode.FileSystemError("vscode-forester doesn't support opening a single file.");
  }
}

function update() {
  if (! dirty) {
    return;
  }
  if (cancel !== undefined) {
    cancel.cancel();
  }
  cancel = new vscode.CancellationTokenSource();

  dirty = false;
  cachedQuery = Promise.race([
    util.promisify((callback : (...args: any) => void) => {
      // If cancelled, return {} immediately
      cancel?.token.onCancellationRequested((e) => {
        callback(undefined, {});
      });
    })(),
    // The token is also used to cancel the stuff inside
    server.query(getRoot(), cancel.token)
  ]);
}

async function suggest(range: vscode.Range) {
  var results : vscode.CompletionItem[] = [];
  const config = vscode.workspace.getConfiguration('forester');
  const showID = config.get('completion.showID') ?? false;
  for (const [id, { title, taxon }] of Object.entries(await cachedQuery)) {
    let item = new vscode.CompletionItem(
      { label: title === null ? `[${id}]` :
          showID ? `[${id}] ${title}` : title ,
        description: taxon ?? "" },
      vscode.CompletionItemKind.Value
    );
    item.range = range;
    item.insertText = id;
    item.filterText = `${id} ${title ?? ""} ${taxon ?? ""}`;
    item.detail = `${taxon ?? "Tree"} [${id}]`;
    item.documentation = title ?? undefined;
    results.push(item);
  }
  return results;
}

export class ForesterDefinitionProvider implements vscode.DefinitionProvider, vscode.Disposable {
  constructor() { }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ) {
      const range = document.getWordRangeAtPosition(position, /[\w\d-]+/);
      if (!range) {
        return null;
      }
      const word = document.getText(range);

      const root = getRoot();
      // If we cancel, we kill the process
      update();
      let killswitch = token.onCancellationRequested(() => {
        dirty = true;
        cancel?.cancel();
      });
      const cq = await cachedQuery;
      if(word in cq) {
        const { sourcePath } = cq[word];
        const filePath = sourcePath;
        const definitionUri = vscode.Uri.file(filePath);
        let range_begin = new vscode.Position(0, 0);
        let range_end = new vscode.Position(0, 0);
        let position_range = new vscode.Range(range_begin, range_end);

        killswitch.dispose();

        return new vscode.Location(definitionUri, position_range);
      } else {
        killswitch.dispose();
        return null;
      }
  }

  dispose() {
    // Clean up
  }
}

export class ForesterHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  constructor() { }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ) {
      const range = document.getWordRangeAtPosition(position, /[\w\d-]+/);
      if (!range) {
        return null;
      }
      const word = document.getText(range);

      const root = getRoot();
      // If we cancel, we kill the process
      update();
      let killswitch = token.onCancellationRequested(() => {
        dirty = true;
        cancel?.cancel();
      });
      const cq = await cachedQuery;
      if(word in cq) {
        const { title, taxon, tags, route, metas } = cq[word];
        let contents = [];
        if (taxon !== null) {
          contents.push(`_${taxon}._`);
        }

        if (title !== null) {
          contents.push(title);
        }
        // if (tags.length > 0) {
        //   contents.push(`Tags: ${tags.join(", ")}`);
        // }
        // if (route !== "") {
        //   contents.push(`Route: ${route}`);
        // }
        // for (const [key, value] of Object.entries(metas)) {
        //   contents.push(`${key}: ${value}`);
        // }
        killswitch.dispose();
        return new vscode.Hover(contents.join(" "));
      } else {
        killswitch.dispose();
        return null;
      }
  }

  dispose() {
    // Clean up
  }
}

export class ForesterWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {

  async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
    const root = getRoot();
    // If we cancel, we kill the process
    update();
    let killswitch = token.onCancellationRequested(() => {
      dirty = true;
      cancel?.cancel();
    });
    const cq = await cachedQuery;
    let results: vscode.SymbolInformation[] = [];

    let range_begin = new vscode.Position(0, 0);
    let range_end = new vscode.Position(0, 0);
    let position_range = new vscode.Range(range_begin, range_end);

    killswitch.dispose();

    const fuzzyquery = query.toLowerCase();

    for (const [id, { title, taxon }] of Object.entries(cq)) {
      const fuzzyid = id.toLowerCase();
      const fuzzytitle = title?.toLowerCase();
      const fuzzytaxon = taxon?.toLowerCase();

      if (fuzzyid.includes(fuzzyquery) || fuzzytitle?.includes(fuzzyquery) || fuzzytaxon?.includes(fuzzyquery)) {
        results.push(new vscode.SymbolInformation(
          title ?? id,
          vscode.SymbolKind.Class,
          id,
          new vscode.Location(vscode.Uri.file(cq[id].sourcePath), position_range)
        ));
      }
    }
    killswitch.dispose();
    return results;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.tree');
  watcher.onDidCreate(() => { dirty = true; });
  watcher.onDidChange(() => { dirty = true; });
  watcher.onDidDelete(() => { dirty = true; });
  update();

  const selector: vscode.DocumentSelector = { scheme: 'file', language: 'forester' };

  context.subscriptions.push(
    watcher,
    vscode.languages.registerDefinitionProvider(selector, new ForesterDefinitionProvider()),
    vscode.languages.registerHoverProvider(selector, new ForesterHoverProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new ForesterWorkspaceSymbolProvider()),
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        async provideCompletionItems(doc, pos, tok, _) {
          // see if we should complete
          // \transclude{, \import{, \export{, \ref, [link](, [[link
          // There are three matching groups for the replacing content
          const tagPattern =
            /(?:\\transclude{|\\import{|\\export{|\\ref{|\\citek{)([^}]*)$|\[[^\[]*\]\(([^\)]*)$|\[\[([^\]]*)$|\\citet\{[^\}]*\}\{([^\}]*)$/d;
          const text = doc.getText(
            new vscode.Range(new vscode.Position(pos.line, 0), pos)
          );
          let match = tagPattern.exec(text);

          if (match === null || match.indices === undefined) {
            return [];
          }

          // Get the needed range
          let ix =
            match.indices[1]?.[0] ??
            match.indices[2]?.[0] ??
            match.indices[3]?.[0] ??
            pos.character;
          let range = new vscode.Range(
            new vscode.Position(pos.line, ix),
            pos
          );

          // If we cancel, we kill the process
          update();
          let killswitch = tok.onCancellationRequested(() => {
            dirty = true;
            cancel?.cancel();
          });
          let result = await suggest(range);
          killswitch.dispose();
          return result;
        },
        // resolveCompletionItem, we can extend the CompletionItem class to inject more information
      },
      '{', '(', '['
    ),
    vscode.commands.registerCommand(
      "forester.new",
      async function (folder ?: vscode.Uri) {
        if (folder === undefined) {
          // Try to get from focused folder
          // https://github.com/Microsoft/vscode/issues/3553

          // "view/title": [
          //   {
          //     "command": "forester.new",
          //     "when": "view == workbench.explorer.fileView",
          //     "group": "navigation"
          //   }
          // ],
          return;
        }
        let root = getRoot();
        // Get prefixes from configuration
        const config = vscode.workspace.getConfiguration('forester');
        let configfile : string | undefined = config.get('config');
        if (! configfile) {
          configfile = "forest.toml";
        }
        const toml = await readFile(join(root.fsPath, configfile), {
          encoding: 'utf-8'
        });
        let obj : {forest ?: {prefixes ?: string[]}} = load(toml);
        let prefixes: string[] | undefined = obj?.forest?.prefixes;
        // Ask about prefix and template in a quick pick
        // https://code.visualstudio.com/api/references/vscode-api#window.showQuickPick
        var prefix: string | undefined = undefined;
        // allow the option to just use a new prefix
        if (prefixes) {
          prefix = await vscode.window.showQuickPick(
            prefixes,
            {
              canPickMany: false,
              placeHolder: "Choose prefix or Escape to use new one"
            }
          );
        }
        if (prefix === undefined) {
          prefix = await vscode.window.showInputBox(
            {
              placeHolder: "Enter a prefix or Escape to cancel"
            }
          );
        }
        if (prefix === undefined) {
          return;  // Cancelled
        }

        let templates = (await vscode.workspace.fs.readDirectory(
          vscode.Uri.joinPath(root, 'templates')
        ))
        .filter(([n, f]) => f === vscode.FileType.File && n.endsWith(".tree"))
        .map(([n, f]) => n.slice(0, -5));
        var template: string | undefined = undefined;
        templates.push("(No template)");
        if (templates) {
          template = await vscode.window.showQuickPick(
            templates,
            {
              canPickMany: false,
              placeHolder: "Choose a template"
            }
          );
        }
        if (template === undefined) {
          return;
        } else if (template === "(No template)") {
          template = undefined;
        }

        const random : boolean = vscode.workspace
          .getConfiguration('forester')
          .get('create.random') ?? false;
        let result = (await server.command(root, ["new",
          "--dest", folder.fsPath,
          "--prefix", prefix,
          ...(template ? [`--template=${template}`] : []),
          ...(random ? ["--random"] : [])
        ]))?.trim();
        if (result) {
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(result)
          );
        }
      }
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
