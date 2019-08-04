import {
    LoggingDebugSession, InitializedEvent, logger, Logger,
    Breakpoint, StoppedEvent, Thread,
    Source, Scope, Handles, StackFrame, TerminatedEvent,
} from 'vscode-debugadapter'
import { DebugProtocol } from 'vscode-debugprotocol'

import { Subject } from './subject'
import { basename, dirname } from 'path'
import { DebugMessage } from './models'
import { client as WebSocket, connection as Connection } from 'websocket'
import * as jayson from 'jayson'

const DEBUG_LOGS = true
export const THREAD_ID = 0
export const THREAD_NAME = 'main'

type DebuggerMethods = 'start' | 'step' | 'continue' | 'stop'

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** Identifier */
    name: string
    /** An absolute path to the "program" to debug. */
    program: string
    /** Format register values */
    registerFormat?: 'hex' | 'oct' | 'dec' | 'bin'
    /** Where to launch the debug target: integrated terminal, or external terminal. */
    console: 'integratedTerminal' | 'externalTerminal'
    /** Arguments for mips program */
    args: string[]
    /** Arguments for dashmips debugger */
    dashmipsArgs: string[]
    /** The command used to launch dashmips debugger */
    dashmipsCommand: string
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    host: string
    port: number
}

export class DashmipsDebugSession extends LoggingDebugSession {
    private configurationDone = new Subject()
    private variableHandles = new Handles<string>()
    private dashmipsHandle?: DebugProtocol.RunInTerminalResponse
    private config?: LaunchRequestArguments
    private clientLaunched = new Subject()
    private ws: WebSocket
    private wsConnection?: Connection
    private id: number

    private set loggingEnabled(value: boolean) {
        logger.setup(value ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, true)
    }

    public constructor() {
        super()
        this.setDebuggerLinesStartAt1(true)
        this.setDebuggerColumnsStartAt1(false)
        this.loggingEnabled = DEBUG_LOGS
        this.ws = new WebSocket()
        this.id = 1
    }

    protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
        response.body = response.body || {}
        response.body.supportsConfigurationDoneRequest = true
        response.body.supportsEvaluateForHovers = true
        response.body.supportsStepBack = false
        response.body.supportsValueFormattingOptions = true
        this.sendResponse(response)
        this.sendEvent(new InitializedEvent())
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) {
        super.configurationDoneRequest(response, args)
        // notify the launchRequest that configuration has finished
        this.configurationDone.notify()
    }

    private async requestTerminalLaunch(launchArgs: LaunchRequestArguments): Promise<string | void> {
        // This will never reject, since vscode is weird with long running processes
        // We will detect failure to launch when we are unable to connect to ws
        return new Promise(resolve => {
            const args = [...launchArgs.dashmipsCommand.split(' '), ...launchArgs.dashmipsArgs, launchArgs.program]
            if (launchArgs.args && launchArgs.args.length > 0) {
                // Mips arguments
                args.push('-a', ...launchArgs.args)
            }

            const kind = launchArgs.console.slice(0, -('Terminal'.length))

            const termArgs = {
                title: 'Dashmips',
                kind,
                args,
            } as DebugProtocol.RunInTerminalRequestArguments

            const termReqHandler = (resp: DebugProtocol.Response | DebugProtocol.RunInTerminalResponse) => {
                this.dashmipsHandle = resp as DebugProtocol.RunInTerminalResponse
                if (!resp.success) {
                    logger.error('vscode failed to launch dashmips')
                    this.sendEvent(new TerminatedEvent())
                    return resolve('timeout')
                }
                resolve()
            }
            this.sendRequest('runInTerminal', termArgs, 2000, termReqHandler)
        })
    }

    private async callDebuggerMethod(method: DebuggerMethods, params: any[] = []) {
        return new Promise((resolve, reject) => {
            if (!this.wsConnection) {
                return reject(new Error('Cannot send with no connection'))
            }
            this.wsConnection.on('message', data => {
                return resolve(JSON.parse(data.utf8Data!))
            })
            this.wsConnection.send(JSON.stringify({
                method,
                params,
                jsonrpc: '2.0',
                id: (this.id++),
            }))
        })
    }

    private async connectToDashmips(host: string, port: number) {
        return new Promise((resolve, reject) => {
            this.ws.once('connect', async (connection: Connection) => {
                this.wsConnection = connection
                await this.callDebuggerMethod('start')
                this.wsConnection.on('close', () => this.shutdown())
                this.wsConnection.on('error', () => this.shutdown())
                this.clientLaunched.notify()
                resolve()
            })
            this.ws.connect(`ws://${host}:${port}`)
        })
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        await this.requestTerminalLaunch(args) // always succeeds
        try {
            await this.connectToDashmips('localhost', 2390)
            this.sendResponse(response)
        } catch (ex) {
            DashmipsDebugSession.processError(ex, () => {
                this.sendErrorResponse(response, ex)
                this.sendEvent(new TerminatedEvent())
            })
        }
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments) {
        await this.connectToDashmips(args.host, args.port)
        this.sendResponse(response)
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
        await this.clientLaunched.wait(Infinity)

        if (!args.breakpoints) {
            return this.sendResponse(response)
        }

        const breakpoints = args.breakpoints.map(bp => ({
            src: new Source(
                basename(args.source.path!),
                this.convertDebuggerPathToClient(args.source.path!),
                undefined, undefined, 'dashmips'
            ),
            ...bp
        })).map(bp => new Breakpoint(true, bp.line, bp.column, bp.src))

        const res = await this.callDebuggerMethod('continue', breakpoints)

        response.body = {
            breakpoints
        }
        return this.sendResponse(response)
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
        response.body = {
            threads: [new Thread(THREAD_ID, THREAD_NAME)]
        }
        this.sendResponse(response)
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
        // response.body = {
        //     stackFrames: this.client!.stack.map(f => {
        //         return new StackFrame(f.index, f.name,
        //             new Source(
        //                 basename(f.file),
        //                 this.convertDebuggerPathToClient(f.file),
        //                 undefined, undefined, 'dashmips-adapter-data'),
        //             f.line
        //         )
        //     }),
        //     totalFrames: this.client!.stack.length,
        // }
        this.sendResponse(response)
    }

    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
        const scopes: Scope[] = []
        scopes.push(new Scope(
            'Registers',
            this.variableHandles.create('register'),
            false
        ))
        response.body = { scopes }
        this.sendResponse(response)
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
        this.sendResponse(response)
    }

    formatRegister(value: number): string {
        switch (this.config!.registerFormat) {
            case 'hex':
                return '0x' + value.toString(16).padStart(8, '0')
            case 'oct':
                return '0o' + value.toString(8).padStart(11, '0')
            case 'bin':
                return '0b' + value.toString(2).padStart(32, '0')
            case 'dec':
            default:
                return value.toString(10).padStart(10, '0')
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
        this.sendResponse(response)
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
        this.sendResponse(response)
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
        this.sendResponse(response)
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
        process.kill(this.dashmipsHandle!.body.processId!, 'SIGINT')
        this.shutdown()
    }

    static processError = (err: Error, cb?: () => void) => {
        logger.error(`Exception: ${err && err.message ? err.message : ''}`)
        logger.error(err && err.name ? err.name : '')
        logger.error(err && err.stack ? err.stack : '')
        // Catch all, incase we have string exceptions being raised.
        logger.error(err ? err.toString() : '')
        // Wait for 1 second before we die,
        // we need to ensure errors are written to the log file.
        setTimeout(cb ? cb : () => { }, 1000)
    }

}
