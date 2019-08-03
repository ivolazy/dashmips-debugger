'use strict'
import * as Net from 'net'
import * as vscode from 'vscode'
import { execSync } from 'child_process'
import {
    CancellationToken,
    debug,
    DebugConfiguration,
    DebugConfigurationProvider,
    ProviderResult,
    WorkspaceFolder
} from 'vscode'

import { isDashmipsInstalled } from './client'
import { MipsDebugSession } from './debug'

const EMBED_DEBUG_ADAPTER = true

export async function activate(context: vscode.ExtensionContext) {
    try {
        return await activateUnsafe(context)
    } catch (ex) {
        console.error('Failed to activate extension:', ex)
        throw ex
    }
}

async function activateUnsafe(context: vscode.ExtensionContext) {
    if (!isDashmipsInstalled()) {
        vscode.window.showErrorMessage('Install Dashmips with pip?', 'Yes', 'No').then(value => {
            if (value === 'Yes') {
                const term = vscode.window.createTerminal('Install Dashmips')
                term.show(true)
                term.sendText('pip install dashmips', true)
            }
        })
    }
    const provider = new DashmipsConfigurationProvider()
    context.subscriptions.push(debug.registerDebugConfigurationProvider('dashmips', provider))
    context.subscriptions.push(provider)

    if (EMBED_DEBUG_ADAPTER) {
        const factory = new DashmipsDebugAdapterDescriptorFactory()
        context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('dashmips', factory))
        context.subscriptions.push(factory)
    }
}

export function deactivate() { }

export class DashmipsConfigurationProvider implements DebugConfigurationProvider {

    private server?: Net.Server
    private terminal?: vscode.Terminal

    // provideDebugConfigurations?(folder?: WorkspaceFolder, token?: CancellationToken): ProviderResult<DebugConfiguration[]> {}

    resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

        config.internalConsoleOptions = 'neverOpen'

        if (!config.type && !config.request && !config.name) {
            // No configuration generated yet
            const editor = vscode.window.activeTextEditor
            if (editor && editor.document.languageId === 'mips') {
                config.type = 'dashmips'
                config.name = 'dashmips (Run Current File)'
                config.request = 'launch'
                config.program = '${file}'
                config.dashmipsCommand = 'python -m dashmips debug'
            }
        }

        if (!config.program) {
            return vscode.window.showInformationMessage('Cannot find a program to debug').then(() => undefined)
        }

        const defaults = {
            args: [],
            console: 'integratedTerminal',
            dashmipsCommand: 'python -m dashmips debug',
            name: 'dashmips (Run Current File)',
        }

        return { ...defaults, ...config } as DebugConfiguration
    }

    async startDashmipsInstance(folder: WorkspaceFolder, config: DebugConfiguration) {
        const debuggerCommand = 'python -m dashmips debug'

        // Debug console not at all useful.
        config.internalConsoleOptions = 'neverOpen'

        if (!config.type && !config.request && !config.name) {
            // No configuration generated yet
            const editor = vscode.window.activeTextEditor
            if (editor && editor.document.languageId === 'mips') {
                config.type = 'dashmips'
                config.name = 'dashmips (Run Current File)'
                config.request = 'launch'
                config.program = '${file}'
                config.stopOnEntry = true
                config.dashmipsCommand = debuggerCommand
            }
        }

        if (!config.program) {
            await vscode.window.showInformationMessage('Cannot find a program to debug')
            throw Error('No program specified')
        }

        const debugArgs = [config.dashmipsCommand, ...config.dashmipsArgs, config.program]
        if (config.args && config.args.length > 0) {
            // Mips arguments
            debugArgs.push('-a', ...config.args)
        }

        return debugArgs.join(' ')
    }

    dispose() {
        if (this.server) {
            this.server.close()
        }
    }
}

export class DashmipsDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

    private server?: Net.Server

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

        if (!this.server) {
            // start listening on a random port
            if (!this.server) {
                this.server = Net.createServer(socket => {
                    const session = new MipsDebugSession()
                    session.setRunAsServer(true)
                    session.start(socket as NodeJS.ReadableStream, socket)
                }).listen(0)
            }
        }

        const addr = (this.server.address() as Net.AddressInfo)
        // make VS Code connect to debug server
        return new vscode.DebugAdapterServer(addr.port)
    }

    dispose() {
        if (this.server) {
            this.server.close()
        }
    }
}

export function checkDashmipsExists(): boolean {
    try {
        execSync(
            'python -m dashmips -v', { encoding: 'utf8' }
        )
        return true
    } catch {
        return false
    }
}
