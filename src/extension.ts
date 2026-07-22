import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('vscodesim.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from vscodesim!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
