/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as vscode from 'vscode';
import * as util from '../common';
import * as telemetry from '../telemetry';
import * as cpptools from './workspaceFolder';
import { getCustomConfigProviders } from './customProviders';

const rootWorkspaceFolderKey: string = "@@workspace@@";
export interface WorkspaceFolderKey {
    name: string;
    key: string;
}

export class Workspace {
    private disposables: vscode.Disposable[] = [];
    private workspaceFolders = new Map<string, cpptools.WorkspaceFolder>();
    private externalWorkspaceFolder: cpptools.WorkspaceFolder; // For files not associated with any WorkspaceFolder.
    private activeWorkspaceFolder: cpptools.WorkspaceFolder;
    private activeDocument: vscode.TextDocument;

    public get ActiveWorkspaceFolder(): cpptools.WorkspaceFolder { return this.activeWorkspaceFolder; }
    public get Names(): WorkspaceFolderKey[] {
        let result: WorkspaceFolderKey[] = [];
        this.workspaceFolders.forEach((workspaceFolder, key) => {
            result.push({ name: workspaceFolder.Name, key: key });
        });
        return result;
    }
    public get Count(): number { return this.workspaceFolders.size; }

    constructor() {
        this.externalWorkspaceFolder = cpptools.createWorkspaceFolder(this);
        this.activeWorkspaceFolder = this.externalWorkspaceFolder;
        this.workspaceFolders.set(rootWorkspaceFolderKey, this.externalWorkspaceFolder);
        for (let workspaceFolder of vscode.workspace.workspaceFolders) {
            this.workspaceFolders.set(util.asFolder(workspaceFolder.uri), cpptools.createWorkspaceFolder(this, workspaceFolder));
        }

        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(e => this.onDidChangeWorkspaceFolders(e)));
        this.disposables.push(vscode.workspace.onDidOpenTextDocument(d => this.onDidOpenTextDocument(d)));
        this.disposables.push(vscode.workspace.onDidCloseTextDocument(d => this.onDidCloseTextDocument(d)));
    }

    public activeDocumentChanged(document: vscode.TextDocument): void {
        this.activeDocument = document;
        let activeWorkspaceFolder: cpptools.WorkspaceFolder = this.getWorkspaceFolderFor(document.uri);

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
    public get(key: string): cpptools.WorkspaceFolder | null {
        if (this.workspaceFolders.has(key)) {
            return this.workspaceFolders.get(key);
        }
        console.assert("key not found");
        return null;
    }

    public forEach(callback: (workspaceFolder: cpptools.WorkspaceFolder) => void): void {
        this.workspaceFolders.forEach(callback);
    }

    public checkOwnership(workspaceFolder: cpptools.WorkspaceFolder, document: vscode.TextDocument): boolean {
        let vsWorkspaceFolder: vscode.WorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        return (!workspaceFolder.RootUri && !vsWorkspaceFolder) ||
            (vsWorkspaceFolder && (workspaceFolder.RootUri === vsWorkspaceFolder.uri));
    }

    /**
     * creates a new WorkspaceFolder to replace one that crashed.
     */
    public replace(workspaceFolder: cpptools.WorkspaceFolder, transferFileOwnership: boolean): cpptools.WorkspaceFolder {
        let key: string;
        for (let pair of this.workspaceFolders) {
            if (pair[1] === workspaceFolder) {
                key = pair[0];
                break;
            }
        }

        if (key) {
            this.workspaceFolders.delete(key);

            if (transferFileOwnership) {
                // This will create a new WorkspaceFolder since we removed the old one from this.workspaceFolders.
                workspaceFolder.TrackedDocuments.forEach(document => this.transferOwnership(document, workspaceFolder));
                workspaceFolder.TrackedDocuments.clear();
            } else {
                // Create an empty WorkspaceFolder that will continue to "own" files matching this workspace, but ignore all messages from VS Code.
                this.workspaceFolders.set(key, cpptools.createNullWorkspaceFolder());
            }

            if (this.activeWorkspaceFolder === workspaceFolder && this.activeDocument) {
                this.activeWorkspaceFolder = this.getWorkspaceFolderFor(this.activeDocument.uri);
                this.activeWorkspaceFolder.activeDocumentChanged(this.activeDocument);
            }

            workspaceFolder.dispose();
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
                let workspaceFolder: cpptools.WorkspaceFolder = this.workspaceFolders.get(path);
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

    private transferOwnership(document: vscode.TextDocument, oldOwner: cpptools.WorkspaceFolder): void {
        let newOwner: cpptools.WorkspaceFolder = this.getWorkspaceFolderFor(document.uri);
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

    private getWorkspaceFolderFor(uri: vscode.Uri): cpptools.WorkspaceFolder {
        let folder: vscode.WorkspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            return this.externalWorkspaceFolder;
        } else {
            let key: string = util.asFolder(folder.uri);
            if (!this.workspaceFolders.has(key)) {
                let newWorkspaceFolder: cpptools.WorkspaceFolder = cpptools.createWorkspaceFolder(this, folder);
                this.workspaceFolders.set(key, newWorkspaceFolder);
                getCustomConfigProviders().forEach(provider => newWorkspaceFolder.onRegisterCustomConfigurationProvider(provider));
            }
            return this.workspaceFolders.get(key);
        }
    }

    private onDidCloseTextDocument(document: vscode.TextDocument): void {
        // Don't seem to need to do anything here since we clean up when the workspace is closed instead.
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
