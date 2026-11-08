// Shared HTML shell for SkillTree webviews: nonce-based CSP, local bundled assets only.
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export type WebviewPage = 'graph' | 'marketplace' | 'activity';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableCommandUris: false,
    enableForms: false,
    retainContextWhenHidden: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
  };
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: WebviewPage, title: string): string {
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.css'));
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    // React Flow positions nodes with inline style attributes.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${title}</title>
</head>
<body>
<div id="root" data-page="${page}"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
