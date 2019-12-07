/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as vscode from 'vscode';
import * as util from '../common';
import * as telemetry from '../telemetry';
import * as Client from './client';
import { getCustomConfigProviders } from './customProviders';
import { WorkspaceFolder } from './workspaceFolder';

//const externalWorkspaceFolderKey: string = "@@external@@";
export interface WorkspaceFolderKey {
    name: string;
    key: string;
}

export class Workspace {
    private client: Client.Client;
    private disposables: vscode.Disposable[] = [];
    private workspaceFolders = new Map<string, WorkspaceFolder>();
    //private externalWorkspaceFolder: WorkspaceFolder; // For files not associated with any WorkspaceFolder.
    private firstWorkspaceFolder: WorkspaceFolder; // WorkspaceFolder with the lowest index.
    private activeWorkspaceFolder: WorkspaceFolder;
    private activeDocument: vscode.TextDocument;

    private get ActiveWorkspaceFolder(): WorkspaceFolder { return this.activeWorkspaceFolder; }
    private get Names(): WorkspaceFolderKey[] {
        let result: WorkspaceFolderKey[] = [];
        this.workspaceFolders.forEach((workspaceFolder, key) => {
            result.push({ name: workspaceFolder.Name, key: key });
        });
        return result;
    }
    public get Name(): string {
        return vscode.workspace.name ? vscode.workspace.name : "untitled";
    }
    public get FirstWorkspaceFolder(): WorkspaceFolder { return this.firstWorkspaceFolder; }

    private get Count(): number { return this.workspaceFolders.size; }

    constructor() {
        //this.externalWorkspaceFolder = new WorkspaceFolder();
        //this.workspaceFolders.set(externalWorkspaceFolderKey, this.externalWorkspaceFolder);
        this.client = Client.createClient(this);
        if (vscode.workspace.workspaceFolders) {
            for (let i: number = 0; i < vscode.workspace.workspaceFolders.length; ++i) {
                let vsWorkspaceFolder: vscode.WorkspaceFolder = vscode.workspace.workspaceFolders[i];
                let curWorkspaceFolder: WorkspaceFolder = new WorkspaceFolder(vsWorkspaceFolder, this.client);
                this.workspaceFolders.set(util.asFolder(vsWorkspaceFolder.uri), curWorkspaceFolder);
                if (i === 0) {
                    this.firstWorkspaceFolder = curWorkspaceFolder;
                }
            }
        //} else {
        //    this.firstWorkspaceFolder = this.externalWorkspaceFolder;
       // }
        this.activeWorkspaceFolder = this.firstWorkspaceFolder;

        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(e => this.onDidChangeWorkspaceFolders(e)));
        this.disposables.push(vscode.workspace.onDidOpenTextDocument(d => this.onDidOpenTextDocument(d)));
    }

    private activeDocumentChanged(document: vscode.TextDocument): void {
        this.activeDocument = document;
        let activeWorkspaceFolder: Client.Client = this.getWorkspaceFolderFor(document.uri);

        // Notify the active WorkspaceFolder that the document has changed.
        activeWorkspaceFolder.activeDocumentChanged(document);

        // If the active WorkspaceFolder changed, resume the new WorkspaceFolder and tell the currently active WorkspaceFolder to deactivate.
        if (activeWorkspaceFolder !== this.activeWorkspaceFolder) {
            activeWorkspaceFolder.activate();
            this.activeWorkspaceFolder.deactivate();
            this.activeWorkspaceFolder = activeWorkspaceFolder;
        }
    }

    /**
     * get a handle to a WorkspaceFolder. returns null if the WorkspaceFolder was not found.
     */
    private get(key: string): Client.Client | null {
        if (this.workspaceFolders.has(key)) {
            return this.workspaceFolders.get(key);
        }
        console.assert("key not found");
        return null;
    }

    public forEach(callback: (workspaceFolder: Client.Client) => void): void {
        this.workspaceFolders.forEach(callback);
    }

    public checkOwnership(workspaceFolder: Client.Client, document: vscode.TextDocument): boolean {
        let vsWorkspaceFolder: vscode.WorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        return (!workspaceFolder.RootUri && !vsWorkspaceFolder) ||
            (vsWorkspaceFolder && (workspaceFolder.RootUri === vsWorkspaceFolder.uri));
    }

    /**
     * creates a new Client to replace one that crashed.
     */
    public replace(client: Client.Client, transferFileOwnership: boolean): Client.Client {
        let key: string;
        for (let pair of this.workspaceFolders) {
            if (pair[1] === client) {
                key = pair[0];
                break;
            }
        }

        if (key) {
            this.workspaceFolders.delete(key);

            if (transferFileOwnership) {
                // This will create a new WorkspaceFolder since we removed the old one from this.workspaceFolders.
                client.TrackedDocuments.forEach(document => this.transferOwnership(document, client));
                client.TrackedDocuments.clear();
            } else {
                // Create an empty WorkspaceFolder that will continue to "own" files matching this workspace, but ignore all messages from VS Code.
                this.workspaceFolders.set(key, Client.createNullClient());
            }

            if (this.activeWorkspaceFolder === client && this.activeDocument) {
                this.activeWorkspaceFolder = this.getWorkspaceFolderFor(this.activeDocument.uri);
                this.activeWorkspaceFolder.activeDocumentChanged(this.activeDocument);
            }

            client.dispose();
            return this.workspaceFolders.get(key);
        } else {
            console.assert(key, "unable to locate WorkspaceFolder");
            return null;
        }
    }

    private onDidChangeWorkspaceFolders(e?: vscode.WorkspaceFoldersChangeEvent): void {
        let folderCount: number = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
        if (folderCount > 1) {
            telemetry.logLanguageServerEvent("workspaceFoldersChange", { "count": folderCount.toString() });
        }

        if (e !== undefined) {
            e.removed.forEach(folder => {
                let path: string = util.asFolder(folder.uri);
                let workspaceFolder: Client.Client = this.workspaceFolders.get(path);
                if (workspaceFolder) {
                    this.workspaceFolders.delete(path);  // Do this first so that we don't iterate on it during the ownership transfer process.

                    // Transfer ownership of the WorkspaceFolder's documents to another WorkspaceFolder.
                    // (this includes calling textDocument/didOpen on the new WorkspaceFolder so that the server knows it's open too)
                    workspaceFolder.TrackedDocuments.forEach(document => this.transferOwnership(document, workspaceFolder));
                    workspaceFolder.TrackedDocuments.clear();

                    if (this.activeWorkspaceFolder === workspaceFolder && this.activeDocument) {
                        // Need to make a different WorkspaceFolder for the active WorkspaceFolder.
                        this.activeWorkspaceFolder = this.getWorkspaceFolderFor(this.activeDocument.uri);
                        this.activeWorkspaceFolder.activeDocumentChanged(this.activeDocument);
                        // may not need this, the navigation UI should not have changed.
                        // this.activeWorkspaceFolder.selectionChanged(Range.create(vscode.window.activeTextEditor.selection.start, vscode.window.activeTextEditor.selection.end);
                    }

                    workspaceFolder.dispose();
                }
            });
            e.added.forEach(folder => {
                this.getWorkspaceFolderFor(folder.uri);
            });
        }
    }

    private transferOwnership(document: vscode.TextDocument, oldOwner: Client.Client): void {
        let newOwner: Client.Client = this.getWorkspaceFolderFor(document.uri);
        console.assert(newOwner !== oldOwner, "'oldOwner' should not be in the list of WorkspaceFolders to consider");
        newOwner.takeOwnership(document);
    }

    private onDidOpenTextDocument(document: vscode.TextDocument): void {
        if (document.languageId === "c" || document.languageId === "cpp"
            || document.languageId === "json" && document.uri.fsPath.endsWith("c_cpp_properties.json")) {
            // Make sure a WorkspaceFolder exists for this document.
            this.getWorkspaceFolderFor(document.uri);
        }
    }

    private getWorkspaceFolderFor(uri: vscode.Uri): Client.Client {
        let folder: vscode.WorkspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return this.externalWorkspaceFolder;
        } else {
            let key: string = util.asFolder(folder.uri);
            if (!this.workspaceFolders.has(key)) {
                let newWorkspaceFolder: Client.Client = Client.createClient(this, folder);
                this.workspaceFolders.set(key, newWorkspaceFolder);
                getCustomConfigProviders().forEach(provider => newWorkspaceFolder.onRegisterCustomConfigurationProvider(provider));
            }
            return this.workspaceFolders.get(key);
        }
    }

    public dispose(): Thenable<void> {
        let promises: Thenable<void>[] = [];

        // this.rootWorkspaceFolder is already in this.workspaceFolders, so do not call dispose() on it.
        this.externalWorkspaceFolder = undefined;

        this.workspaceFolders.forEach(workspaceFolder => promises.push(workspaceFolder.dispose()));
        this.workspaceFolders.clear();
        return Promise.all(promises).then(() => undefined);
    }
}
