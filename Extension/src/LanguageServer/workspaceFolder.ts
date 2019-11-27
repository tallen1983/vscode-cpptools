/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as vscode from 'vscode';
import * as configs from './configurations';

export class WorkspaceFolder {
    private workspaceFolder?: vscode.WorkspaceFolder;
    private trackedDocuments = new Set<vscode.TextDocument>();
    private configuration: configs.CppProperties;
    private rootPathFileWatcher: vscode.FileSystemWatcher;

    constructor(workspaceFolder?: vscode.WorkspaceFolder) {
        this.workspaceFolder = workspaceFolder;
    }

    public get Path(): string {
        return this.workspaceFolder ? this.workspaceFolder.uri.fsPath : "";
    }
    public get Uri(): vscode.Uri {
        return this.workspaceFolder ? this.workspaceFolder.uri : null;
    }
    public get Name(): string {
        return this.workspaceFolder ? this.workspaceFolder.name : "untitled";
    }
    public get TrackedDocuments(): Set<vscode.TextDocument> {
        return this.trackedDocuments;
    }
}