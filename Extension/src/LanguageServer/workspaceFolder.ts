/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as vscode from 'vscode';
import * as configs from './configurations';
import * as Client from './client';
export class WorkspaceFolder {
    private client: Client.Client;
    private workspaceFolder?: vscode.WorkspaceFolder;
    private trackedDocuments = new Set<vscode.TextDocument>();
    private configuration: configs.CppProperties;
    private disposables: vscode.Disposable[];

    constructor(workspaceFolder: vscode.WorkspaceFolder, client: Client.Client) {
        this.workspaceFolder = workspaceFolder;
        this.client = client;

        this.configuration = new configs.CppProperties(this.Uri);
        this.configuration.ConfigurationsChanged((e) => this.onConfigurationsChanged(e));
        this.configuration.SelectionChanged((e) => this.client.onSelectedConfigurationChanged(e));
        this.configuration.CompileCommandsChanged((e) => this.client.onCompileCommandsChanged(e, this.Path));
        this.disposables.push(this.configuration);
    }

    public get Path(): string {
        return this.workspaceFolder.uri.fsPath;
    }
    public get Uri(): vscode.Uri {
        return this.workspaceFolder.uri;
    }
    public get Name(): string {
        return this.workspaceFolder.name;
    }
    public get TrackedDocuments(): Set<vscode.TextDocument> {
        return this.trackedDocuments;
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
    }
}
