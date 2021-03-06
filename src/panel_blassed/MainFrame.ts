import which from "which";
import blessed from "neo-blessed";
import { BlessedProgram, Widgets, box, text, screen } from "neo-blessed";
import { Logger } from "../common/Logger";
import { BlessedPanel } from './BlessedPanel';
import { FuncKeyBox } from './FuncKeyBox';
import BottomFilesBox from "./BottomFileBox";
import { readerControl } from '../panel/readerControl';
import { Widget } from "./widget/Widget";
import { keyMappingExec, menuKeyMapping, KeyMappingInfo, 
    KeyMapping, RefreshType, 
    Hint, TerminalAllowKeys, 
    Help, getHelpInfo, IHelpInfo, IHelpService } from "../config/KeyMapConfig";
import { menuConfig } from "../config/MenuConfig";
import { BlessedMenu } from "./BlessedMenu";
import { BlessedMcd } from './BlessedMcd';
import { BlessedEditor } from "./BlessedEditor";
import { CommandBox } from './CommandBox';
import { exec } from "child_process";
import colors from "colors";
import selection, { Selection, ClipBoard } from "../panel/Selection";
import { ProgressFunc, IMountList, ProgressResult } from "../common/Reader";
import { messageBox, MSG_BUTTON_TYPE } from "./widget/MessageBox";
import { ProgressBox } from "./widget/ProgressBox";
import { StringUtils } from "../common/StringUtils";
import { Color } from "../common/Color";
import { inputBox } from "./widget/InputBox";
import { HintBox } from "./HintBox";
import { BlessedXterm } from "./BlessedXterm";
import { sprintf } from "sprintf-js";
import { T } from "../common/Translation";
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { draw } from "./widget/BlessedDraw";
import { ImageViewBox } from "./widget/ImageBox";
import { File } from "../common/File";
import { ArchiveReader } from "../panel/archive/ArchiveReader";
import { FileReader } from "../panel/FileReader";

const log = Logger("MainFrame");

let viewCount = 0;

enum VIEW_TYPE {
    NORMAL = 0,
    VERTICAL_SPLIT = 1,
    HORIZONTAL_SPLIT = 2
}

@KeyMapping( KeyMappingInfo.Common )
export class MainFrame implements IHelpService {
    private screen: Widgets.Screen = null;
    private viewType: VIEW_TYPE = VIEW_TYPE.NORMAL;
    private baseWidget = null;
    private blessedFrames: (BlessedMcd | BlessedPanel | BlessedXterm | BlessedEditor)[] = [];
    private blessedMenu = null;
    private funcKeyBox = null;
    private bottomFilesBox: BottomFilesBox = null;
    private hintBox = null;
    private activeFrameNum = 0;
    private commandBox: CommandBox = null;
    public keyLock = false;
    private _keyLockScreen = false;

    constructor() {
        menuKeyMapping( KeyMappingInfo, menuConfig );
    }

    viewName() {
        return "Common";
    }

    @Help(T("Help.Editor"))
    async editorPromise(file: File = null) {
        let view = this.blessedFrames[this.activeFrameNum];
        if ( view instanceof BlessedPanel ) {
            view.destroy();

            const newView = new BlessedEditor( { parent: this.baseWidget, viewCount: viewCount++ }, view.getReader() );
            newView.setFocus();
            this.blessedFrames[this.activeFrameNum] = newView;

            try {
                await newView.load( file || view.currentFile() );
            } catch ( e ) {
                await messageBox({
                    parent: this.baseWidget,
                    title: T("Error"),
                    msg: T("Message.FILE_OPEN_FAILURE") + "\n" + e.message,
                    button: [ T("OK") ]
                });
                return await this.editorPromise(file);
            }
        } else if ( view instanceof BlessedEditor ) {
            view.destroy();

            const newView = new BlessedPanel( { parent: this.baseWidget, viewCount: viewCount++ }, view.getReader() );
            await newView.read( view.getReader().currentDir() || "." );
            newView.setFocus();
            newView.focusFile( view.getFile() );
            this.blessedFrames[this.activeFrameNum] = newView;
        } else if ( view instanceof BlessedXterm || view instanceof BlessedEditor ) {
            return RefreshType.NONE;
        }
        this.viewRender();
        this.baseWidget.render();
        return RefreshType.ALL;
    }

    @Hint({ hint: T("Hint.Mcd") })
    @Help(T("Help.Mcd"))
    async mcdPromise(isEscape = false) {
        let view = this.blessedFrames[this.activeFrameNum];
        if ( view instanceof BlessedPanel ) {
            view.destroy();

            const newView = new BlessedMcd( { parent: this.baseWidget, viewCount: viewCount++ }, view.getReader(), view.currentPath() );
            await newView.scanDir( view.currentPath() );
            newView.setFocus();
            this.blessedFrames[this.activeFrameNum] = newView;
        } else if ( view instanceof BlessedMcd ) {
            view.destroy();

            const newView = new BlessedPanel( { parent: this.baseWidget, viewCount: viewCount++ }, view.getReader() );
            await newView.read( isEscape ? view.firstScanPath : view.currentPathFile());
            newView.setFocus();
            this.blessedFrames[this.activeFrameNum] = newView;
        } else if ( view instanceof BlessedXterm ) {
            return RefreshType.NONE;
        }
        this.viewRender();
        this.baseWidget.render();
        return RefreshType.ALL;
    }

    async archivePromise(file: File = null) {
        let view = this.blessedFrames[this.activeFrameNum];
        if ( view instanceof BlessedPanel && file.fstype === "file" ) {
            let reader = new ArchiveReader();
            const progressBox = new ProgressBox( { title: T("Message.Archive"), msg: T("Message.Calculating"), cancel: () => {
                reader.isUserCanceled = true;
            }}, { parent: this.baseWidget } );
            this.screen.render();
            await new Promise( (resolve) => setTimeout( () => resolve(), 1 ));
            
            let copyBytes = 0;
            let befCopyInfo = { beforeTime: Date.now(), copyBytes };
        
            let refreshTimeMs = 100;
            let fullFileSize = file.size;
            const progressStatus: ProgressFunc = ( source, processSize, size, chunkLength ) => {
                copyBytes = processSize;
                let repeatTime = Date.now() - befCopyInfo.beforeTime;
                if ( repeatTime > refreshTimeMs ) {
                    let bytePerSec = Math.round((copyBytes - befCopyInfo.copyBytes) / repeatTime) * 1000;
                    let lastText = (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(copyBytes, false, 1).trim()) + " / " + 
                                    (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(fullFileSize, false, 1).trim());
                    progressBox.updateProgress( source.fullname, lastText, copyBytes, fullFileSize );
                    befCopyInfo.beforeTime = Date.now();
                    befCopyInfo.copyBytes = copyBytes;
                }
                return reader.isUserCanceled ? ProgressResult.USER_CANCELED : ProgressResult.SUCCESS;
            };

            try {
                if ( await reader.setArchiveFile( file, progressStatus ) ) {
                    view.setReader( reader );
                    await view.read( reader.rootDir() );
                    view.setFocus();
                    view.resetPosition();
                }
            } catch( err ) {
                await messageBox({
                    parent: this.baseWidget,
                    title: T("Error"),
                    msg: err.message,
                    button: [ T("OK") ]
                });
            } finally {
                progressBox.destroy();
            }
        } else if ( view instanceof BlessedPanel && 
            file.fstype === "archive" && 
            view.getReader().currentDir().fullname === "/" &&
            file.fullname === "/" && file.name === ".." ) {
            let fileReader = new FileReader();
            view.setReader( fileReader );
            let archiveFile = fileReader.convertFile( file.root, { checkRealPath: true } );
            await view.read( fileReader.convertFile( archiveFile.dirname ) );
            view.focusFile( archiveFile );
        }
    }

    async vimPromise() {
        try {
            let result = await which("vim");
            if ( result ) {
                log.debug( result );
                await this.terminalPromise( false, `vim %1` );
            }
        } catch ( e ) {
            log.error( e );
            await messageBox({
                parent: this.baseWidget,
                title: T("Error"),
                msg: T("Message.VIM_NOT_EXECUTED"),
                button: [ T("OK") ]
            });
        }
    }

    private commandParsing( cmd: string ) {
        if ( cmd ) {
            const panel = this.activePanel();
            if ( panel instanceof BlessedPanel && panel.currentFile() ) {
                cmd = cmd.replace("%1", panel.currentFile().fullname );
            }
        }
        log.debug( "commandParsing : %s", cmd );
        return cmd;
    }

    @Hint({ hint: T("Hint.Terminal"), order: 4 })
    @Help(T("Help.Terminal"))
    async terminalPromise(isEscape = false, shellCmd: string = null ) {
        let view = this.blessedFrames[this.activeFrameNum];        
        let shell: any = this.commandParsing( shellCmd );
        shell = shell ? shell.split(" ") : null;

        if ( view instanceof BlessedPanel ) {
            view.destroy();

            const newView = new BlessedXterm( { parent: this.baseWidget, 
                cursor: 'line',
                cursorBlink: true,
                screenKeys: false,
                shell: shell ? shell[0] : null,
                args: shell ? shell.splice(1) : null,
                viewCount: viewCount++ 
            }, view.getReader(), view.currentPath() );
            newView.on("process_exit", () => {
                process.nextTick( () => {
                    this.terminalPromise( true );
                });
            });
            newView.setFocus();
            this.blessedFrames[this.activeFrameNum] = newView;
        } else if ( view instanceof BlessedMcd ) {
            view.destroy();

            const newView = new BlessedXterm( { parent: this.baseWidget, viewCount: viewCount++,
                    cursor: 'block',
                    cursorBlink: true,
                    screenKeys: false,
                    shell: shell ? shell[0] : null,
                    args: shell ? shell.splice(1) : null,
                }, view.getReader(), view.currentPathFile() );
            newView.on("process_exit", () => {
                process.nextTick( () => {
                    this.terminalPromise( true );
                });
            });
            newView.setFocus();
            this.blessedFrames[this.activeFrameNum] = newView;
        } else if ( view instanceof BlessedXterm ) {
            view.destroy();

            const newView = new BlessedPanel( { parent: this.baseWidget, viewCount: viewCount++ }, view.getReader() );
            await newView.read( view.getCurrentPath() || view.getReader().currentDir() || "." );
            newView.setFocus();
            this.blessedFrames[this.activeFrameNum] = newView;
        }
        this.viewRender();
        this.baseWidget.render();
        return RefreshType.ALL;
    }

    viewRender() {
        const updateWidget = ( widget: Widget, opt ) => {
            widget.top = opt.top;
            widget.left = opt.left;
            widget.height = opt.height;
            widget.width = opt.width;
            widget.box.emit("resize");
            widget.show();
        };

        let { width, height } = this.baseWidget.width;

        log.debug( "mainFrame: width [%d] height [%d]", width, height );

        if ( this.viewType === VIEW_TYPE.NORMAL ) {
            const deActiveNum = (this.activeFrameNum + 1) % 2;
            this.blessedFrames[this.activeFrameNum].setBoxDraw(false);
            updateWidget( this.blessedFrames[this.activeFrameNum].getWidget(), { top: 1, left: 0, width: "100%", height: "100%-3" } );
            this.blessedFrames[deActiveNum].hide();
        } else if ( this.viewType === VIEW_TYPE.VERTICAL_SPLIT ) {
            this.blessedFrames[0].setBoxDraw(true);
            this.blessedFrames[1].setBoxDraw(true);
            updateWidget( this.blessedFrames[0].getWidget(), { top: 1, left: 0, width: "50%", height: "100%-3" } );
            updateWidget( this.blessedFrames[1].getWidget(), { top: 1, left: "50%", width: "50%", height: "100%-3" } );
        } else if ( this.viewType === VIEW_TYPE.HORIZONTAL_SPLIT ) {
            this.blessedFrames[0].setBoxDraw(false);
            this.blessedFrames[1].setBoxDraw(false);
            updateWidget( this.blessedFrames[0].getWidget(), { top: 1, left: 0, width: "100%", height: "50%-1" } );
            updateWidget( this.blessedFrames[1].getWidget(), { top: "50%", left: 0, width: "100%", height: "50%-1" } );
        }
        this.blessedFrames[this.activeFrameNum].setFocus();
    }

    getLastPath() {
        try {
            return fs.readFileSync(os.homedir() + path.sep + ".m" + path.sep + "path", "utf8");
        } catch ( e ) {
            log.error( e );
        }
        return null;
    }

    async start() {
        this.screen = screen({
            smartCSR: true,
            fullUnicode: true,
            dockBorders: false,
            useBCE: true,
            ignoreDockContrast: true,
            tabSize: 4,
            // debug: true,
            // dump: true,
            // log: process.env.HOME + "/.m/m2.log"
        });

        this.screen.draw = (start, end) => {
            log.debug( "draw: %d / %d", start, end );
            draw.call( this.screen, start, end );
        };
        this.screen.enableMouse();

        this.screen.title = "MDIR.js v" + require("../../package.json").version;

        this.baseWidget = new Widget( { parent: this.screen, left: 0, top: 0, width: "100%", height: "100%" } );
        this.blessedMenu = new BlessedMenu({ parent: this.baseWidget });
        this.funcKeyBox = new FuncKeyBox( { parent: this.baseWidget } );
        this.bottomFilesBox = new BottomFilesBox( { parent: this.baseWidget } );

        this.blessedFrames = [
            new BlessedPanel( { parent: this.baseWidget, viewCount: viewCount++ } ),
            new BlessedPanel( { parent: this.baseWidget, viewCount: viewCount++ } )
        ];

        this.hintBox = new HintBox( { parent: this.baseWidget } );

        let lastPath = this.getLastPath();
        for ( var i = 0; i < this.blessedFrames.length; i++ ) {
            const panel = this.blessedFrames[i];
            if ( panel instanceof BlessedPanel ) {
                panel.setReader(readerControl("file"));
                try {
                    await panel.read( i !== 0 ? (lastPath || ".") : ".", false );
                } catch ( e ) {
                    log.error( e );
                    await panel.read( "~" );
                }
            }
        }

        if ( lastPath ) {
            this.viewType = VIEW_TYPE.VERTICAL_SPLIT;
        }
        this.viewRender();

        if ( (global as any).debug ) {
            this.screen.key("C-p", () => {
                process.exit(0);
            });
        }
        
        this.eventStart();
        this.screen.render();
    }

    eventStart() {
        this.screen.off('keypress');
        this.screen.on('keypress', async (ch, keyInfo) => {
            log.debug( "keypress !!!" );
            if ( this._keyLockScreen ) {
                log.debug( "_keyLockScreen !!!");
                return;
            }
            if ( this.keyLock ) {
                log.debug( "keyLock !!!");
                return;
            }
            if ( this.commandBox ) {
                log.debug( "CommandBox running !!!" );
                return;
            }
            const keyName = keyInfo.full || keyInfo.name;
            log.debug( "KEYPRESS [%s] - START", keyName );

            let starTime = Date.now();
            this._keyLockScreen = true;

            const panel = this.activeFocusObj();

            try {
                if ( panel instanceof BlessedPanel ) {
                    if ( await this.activeFocusObj().keyInputSearchFile(ch, keyInfo) ) {
                        this.execRefreshType( RefreshType.OBJECT );
                        this._keyLockScreen = false;
                        return;
                    }
                }

                const keyMappingExecute = async ( func?: () => RefreshType ) => {
                    log.debug( "KEYPRESS - KEY START [%s] - (%dms)", keyInfo.name, Date.now() - starTime );
                    let type: RefreshType = await keyMappingExec( panel, keyInfo );
                    if ( type === RefreshType.NONE ) {
                        type = await keyMappingExec( this, keyInfo );
                    }
                    if ( type !== RefreshType.NONE ) {
                        this.execRefreshType( type );
                    } else {
                        if ( func ) {
                            type = func();
                            this.execRefreshType( type );
                        }
                    }
                    log.info( "KEYPRESS - KEY END [%s] - (%dms)", keyInfo.name, Date.now() - starTime );
                    if ( panel.updateCursor ) {
                        panel.updateCursor();
                    }
                    return type;
                };
                
                if ( panel instanceof BlessedXterm ) {
                    let keyPressFunc = () => {
                        return panel.ptyKeyWrite(keyInfo);
                    };
                    if ( TerminalAllowKeys.indexOf( keyName ) > -1 ) {
                        await keyMappingExecute( keyPressFunc );
                    } else {
                        keyPressFunc();
                        if ( panel.updateCursor ) {
                            panel.updateCursor();
                        }
                    }
                } else if ( panel instanceof BlessedEditor ) {
                    keyMappingExecute( () => {
                        return panel.keyWrite( keyInfo );
                    });
                } else {
                    keyMappingExecute();
                }
            } catch ( e ) {
                log.error( e );
                await messageBox( {
                    parent: this.baseWidget,
                    title: T("Error"), 
                    msg: e.toString(), 
                    textAlign: "left",
                    button: [ T("OK") ] 
                });
            } finally {
                this._keyLockScreen = false;
            }
        });
    }

    execRefreshType( type: RefreshType ) {
        if ( type === RefreshType.ALL ) {
            log.info( "REFRESH - ALL");
            this.screen.realloc();
            this.blessedFrames.forEach( item => {
                if ( item instanceof BlessedPanel ) {
                    item.resetViewCache() 
                }
            });
            this.baseWidget.render();
            this.screen.render();
        } else if ( type === RefreshType.OBJECT ) {
            log.info( "REFRESH - OBJECT");
            this.activeFocusObj().render();
            if ( this.bottomFilesBox ) {
                this.bottomFilesBox.render();
            }
        }
    };

    async refreshPromise() {
        for ( let item of this.blessedFrames ) {
            if ( item instanceof BlessedPanel ) {
                await item.refreshPromise();
            }
        }
        return RefreshType.ALL;
    }

    @Hint({ hint: T("Hint.Split"), order: 2 })
    @Help(T("Help.SplitWindow"))
    split() {
        this.viewType++;
        if ( this.viewType > 2 ) {
            this.viewType = 0;
        }
        log.debug( "split: viewNumber [%d]", (this.viewType as number) );
        this.viewRender();
        return RefreshType.ALL;
    }

    @Hint({ hint: T("Hint.Quit"), order: 1 })
    @Help(T("Help.Quit"))
    async quitPromise() {
        let result = await messageBox( { 
            parent: this.baseWidget, 
            title: T("Question"), 
            msg: T("Message.QuitProgram"), 
            button: [ T("OK"), T("Cancel") ] 
        });

        if ( result !== T("OK") ) {
            return RefreshType.NONE;
        }

        if (this.activePanel() && 
            this.activePanel().getReader() && 
            this.activePanel().getReader().currentDir() && 
            this.activePanel().getReader().readerName === "file" ) {
            let lastPath = this.activePanel().getReader().currentDir().fullname;
            log.debug( "CHDIR : %s", lastPath );
            process.chdir( lastPath );
            try {
                fs.mkdirSync( os.homedir() + path.sep + ".m", { recursive: true, mode: 0o755 });
                fs.writeFileSync( os.homedir() + path.sep + ".m" + path.sep + "path", lastPath, { mode: 0o644 } );
            } catch( e ) {
                log.error( e );
            }
        }
        process.exit(0);
    }

    @Hint({ hint: T("Hint.NextWindow"), order: 2 })
    @Help( T("Help.NextWindow") )
    nextWindow() {
        if ( this.viewType !== VIEW_TYPE.NORMAL ) {
            this.activeFrameNum++;
            if ( this.blessedFrames.length <= this.activeFrameNum ) {
                this.activeFrameNum = 0;
            }
        } else {
            this.activeFrameNum = 0;
        }
        log.debug( "this.activeFrameNum %d", this.activeFrameNum );
        this.blessedFrames[ this.activeFrameNum ].setFocus();
        this.baseWidget.render();
        return RefreshType.ALL;
    }

    setActivePanel( frame: BlessedPanel | BlessedMcd | BlessedXterm | BlessedEditor ) {
        for ( let i = 0; i < this.blessedFrames.length; i++ ) {
            if ( Object.is( this.blessedFrames[i], frame ) && this.activeFrameNum !== i ) {
                this.activeFrameNum = i;
                this.blessedFrames[ this.activeFrameNum ].setFocus();
                this.baseWidget.render();
                break;
            }
        }
    }

    activePanel(): BlessedPanel | BlessedMcd | BlessedXterm | BlessedEditor {
        log.debug( "activePanel %d", this.activeFrameNum );
        return this.blessedFrames[ this.activeFrameNum ];
    }

    activeFocusObj(): any {
        if ( this.blessedMenu && this.blessedMenu.hasFocus() ) {
            return this.blessedMenu;
        }
        return this.activePanel();
    }

    @Hint({ hint: T("Hint.Menu"), order: 3 })
    @Help(T("Help.Menu"))
    menu() {
        const activePanel = this.activePanel();
        if ( (activePanel instanceof BlessedXterm) ) {
            return RefreshType.NONE;
        }
        let viewName = this.activeFocusObj().viewName() || "Common";
        if ( !menuConfig[ viewName ] ) {
            return RefreshType.NONE;
        }
        this.menuClose();
        
        log.debug( "menuConfig[ viewName ] !!!", viewName, menuConfig[ viewName ] );

        this.blessedMenu.init();
        this.blessedMenu.setMainMenuConfig( menuConfig[ viewName ] );
        this.blessedMenu.setFocus();
        return RefreshType.ALL;
    }

    menuClose() {
        const activePanel = this.activePanel();
        if ( (activePanel instanceof BlessedXterm) ) {
            return RefreshType.NONE;
        }
        log.debug( "menuClose !!!" );
        this.blessedMenu.close();
        return RefreshType.ALL;
    }

    @Help(T("Help.PanelSync"))
    async panelSyncPromise() {
        const activePanel = this.activePanel();
        const anotherPanel = this.blessedFrames.find( (item, i) => {
                return item instanceof BlessedPanel && item.getReader().readerName === "file" && this.activeFrameNum !== i;
            });
        if ( activePanel.getReader().readerName === "file" && activePanel instanceof BlessedPanel && anotherPanel instanceof BlessedPanel ) {
            await activePanel.read(anotherPanel.currentPath());
            return RefreshType.ALL;
        }
        return RefreshType.NONE;
    }

    commandBoxShow() {
        const activePanel = this.activePanel();
        if ( !(activePanel instanceof BlessedPanel) ) {
            return RefreshType.NONE;
        }

        if ( this.bottomFilesBox ) {
            this.bottomFilesBox.destroy();
            this.bottomFilesBox = null;
        }

        this.commandBox = new CommandBox( { parent: this.baseWidget }, this.activePanel() );
        this.commandBox.setFocus();
        this.commandBox.on("blur", () => {
            this.commandBoxClose();
        });
        return RefreshType.ALL;
    }

    @Help(T("Help.CommandBoxClose"))
    commandBoxClose() {
        if ( this.commandBox ) {
            this.commandBox.destroy();
            this.commandBox = null;
        }
        this.bottomFilesBox = new BottomFilesBox( { parent: this.baseWidget } );
        this.baseWidget.render();
        return RefreshType.ALL;
    }

    @Hint({ hint: T("Hint.ConsoleView") })
    @Help(T("Help.ConsoleView"))
    consoleViewPromise(): Promise<RefreshType> {
        return new Promise( (resolve, reject) => {
            let program = this.screen.program;
            this._keyLockScreen = true;
            this.screen.leave();
            program.once( 'keypress', async () => {
                this.screen.enter();
                await this.refreshPromise();
                this._keyLockScreen = false;
                resolve(RefreshType.ALL);
            });
        });
    }

    commandRun(cmd, fileRunMode = false ): Promise<void | RefreshType> {
        const activePanel = this.activePanel();
        if ( !(activePanel instanceof BlessedPanel) ) {
            return new Promise( resolve => resolve() );
        }

        if ( !fileRunMode ) {
            let cmds = cmd.split(" ");
            if ( cmds[0] === "cd" && cmds[1] ) {
                let chdirPath = cmds[1] === "-" ? activePanel.previousDir : cmds[1];
                if ( cmds[1] === "~" ) {
                    return activePanel.gotoHomePromise();
                }
                return activePanel.read(chdirPath);
            }
        }

        if ( cmd === "quit" || cmd === "exit" ) {
            return this.quitPromise();
        }

        if ( activePanel.getReader().readerName !== "file" ) {
            return new Promise( resolve => resolve() );
        }

        process.chdir( activePanel.currentPath().fullname );

        return new Promise( (resolve, reject) => {
            let program = this.screen.program;
            if ( !cmd ) {
                resolve();
                return;
            }

            this._keyLockScreen = true;
            this.screen.leave();
            
            if ( fileRunMode ) {
                if ( process.platform === "win32" ) {
                    cmd = `@chcp 65001 >nul & cmd /s/c ""${cmd}""`;
                } else if ( process.platform === "darwin" ) {
                    cmd = `open "${cmd}"`;
                } else if ( process.platform === "linux" ) {
                    cmd = `xdg-open "${cmd}"`;
                }
            } else {
                if ( process.platform === "win32" ) {
                    cmd = "@chcp 65001 >nul & cmd /d/s/c " + cmd;
                }
            }

            process.stdout.write( colors.white("mdir.js $ ") + cmd + "\n");

            exec(cmd, { encoding: "utf-8" }, (error, stdout, stderr) => {
                if (error) {
                    console.error(error.message);
                } else {
                    stderr && process.stderr.write(stderr);
                    stdout && process.stdout.write(stdout);
                }
                process.stdout.write( colors.white(T("Message.ANY_KEY_RETURN_M_JS")) + "\n" );
                program.once( 'keypress', async () => {
                    this.screen.enter();
                    await this.refreshPromise();
                    this._keyLockScreen = false;
                    resolve(RefreshType.ALL);
                });
            });
        });
    }

    async methodRun( methodString, param ): Promise<RefreshType> {
        let item = methodString.split(".");
        
        let viewName: string = item[0] || "";
        let methodName = item[1] || "";
        let object = null;
        if ( viewName.toLowerCase() === this.activePanel().viewName().toLowerCase() ) {
            object = this.activePanel();
        } else if ( /common/i.exec(viewName) ) {
            object = this;
        }

        let result = RefreshType.NONE;
        if ( object && object[ (methodName as string) ] ) {
            log.info( "methodRun [%s] - method: [ %s.%s(%s) ]", methodString, object.viewName(), methodName, param ? param.join(",") : "" );

            if ( /(p|P)romise/.exec(methodName as string) ) {
                result = await object[ (methodName as string) ].apply(object, param);
            } else {
                result = object[ (methodName as string) ].apply(object, param);
            }
        }
        return result || RefreshType.OBJECT;
    }

    aboutPromise(): Promise<RefreshType> {
        return new Promise( (resolve) => {
            setTimeout( async () => {
                let version = require("../../package.json").version;
                await messageBox( {
                    parent: this.baseWidget,
                    title: "Mdir.js - v" + version,
                    msg: T("About", { joinArrays: '\n' }),
                    textAlign: "left",
                    button: [ T("OK") ]
                });
                resolve( RefreshType.ALL );
            }, 100);
        });
    }

    @Hint({ hint: T("Hint.Remove") })
    @Help( T("Help.Remove") )
    async removePromise() {
        const activePanel = this.activePanel();
        if ( !(activePanel instanceof BlessedPanel) ) {
            return RefreshType.NONE;
        }

        let result = await messageBox( { 
                    parent: this.baseWidget, 
                    title: T("Question"), 
                    msg: T("Message.REMOVE_SELECTED_FILES"), 
                    button: [ T("OK"), T("Cancel") ] 
                });

        if ( result !== T("OK") ) {
            return RefreshType.NONE;
        }

        let select = new Selection();
        select.set( activePanel.getSelectFiles(), activePanel.currentPath(), ClipBoard.CLIP_NONE, activePanel.getReader() );

        const reader = activePanel.getReader();
        reader.isUserCanceled = false;

        const progressBox = new ProgressBox( { title: T("Message.Remove"), msg: T("Message.Calculating"), cancel: () => {
            reader.isUserCanceled = true;
        }}, { parent: this.baseWidget } );
        this.screen.render();
        await new Promise( (resolve) => setTimeout( () => resolve(), 1 ));
        
        if ( await select.expandDir() === false ) {
            progressBox.destroy();
            return RefreshType.NONE;
        }

        let files = select.getFiles();
        if ( !files || files.length === 0 ) {
            log.debug( "REMOVE FILES: 0");
            progressBox.destroy();
            return RefreshType.NONE;
        }

        // Sort in filename length descending order.
        files.sort( (a, b) => b.fullname.length - a.fullname.length);

        let beforeTime = Date.now();
        let refreshTimeMs = 300;

        if ( activePanel.getReader().readerName === "file" ) {
            for ( let i = 0; i < files.length; i++ ) {
                let src = files[i];
                try {
                    log.debug( "REMOVE : [%s]", src.fullname);
                    if ( Date.now() - beforeTime > refreshTimeMs ) {
                        progressBox.updateProgress( src.fullname, `${i+1} / ${files.length}`, i+1, files.length );
                        await new Promise( (resolve) => setTimeout( () => resolve(), 1 ));
                        beforeTime = Date.now();
                    }
                    if ( progressBox.getCanceled() ) {
                        break;
                    }
                    await reader.remove( src );
                } catch ( err ) {
                    let result = await messageBox( {
                        parent: this.baseWidget,
                        title: T("Error"),
                        msg: err,
                        button: [ T("Continue"), T("Cancel") ]
                    });
                    if ( result === T("Cancel") ) {
                        break;
                    }
                }
            }
        } else {
            let copyBytes = 0;
            let befCopyInfo = { beforeTime: Date.now(), copyBytes };
            let fullFileSize = 0;

            const progressStatus: ProgressFunc = ( source, copySize, size, chunkLength ) => {
                copyBytes += chunkLength;
                let repeatTime = Date.now() - befCopyInfo.beforeTime;
                if ( repeatTime > refreshTimeMs ) {
                    let bytePerSec = Math.round((copyBytes - befCopyInfo.copyBytes) / repeatTime) * 1000;
                    let lastText = (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(copyBytes, false, 1).trim()) + " / " + 
                                    (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(fullFileSize, false, 1).trim());
                                    // + `(${StringUtils.sizeConvert(bytePerSec, false, 1).trim()}s)`;
                    progressBox.updateProgress( source.fullname, lastText, copyBytes, fullFileSize );
                    befCopyInfo.beforeTime = Date.now();
                    befCopyInfo.copyBytes = copyBytes;
                }
                return reader.isUserCanceled ? ProgressResult.USER_CANCELED : ProgressResult.SUCCESS;
            };
            
            await reader.remove( files, progressStatus );
        }
        progressBox.destroy();
        await this.refreshPromise();
        return RefreshType.ALL;
    }

    @Hint({ hint: T("Hint.Cut"), order: 6 })
    @Help( T("Help.Cut") )
    clipboardCut() {
        const activePanel = this.activePanel();
        if ( !(activePanel instanceof BlessedPanel) ) {
            return ;
        }
        selection().set( activePanel.getSelectFiles(), activePanel.currentPath(), ClipBoard.CLIP_CUT, activePanel.getReader() );
    }

    @Hint({ hint: T("Hint.Copy"), order: 5 })
    @Help( T("Help.Copy") )
    clipboardCopy() {
        const activePanel = this.activePanel();
        if ( !(activePanel instanceof BlessedPanel) ) {
            return ;
        }
        selection().set( activePanel.getSelectFiles(), activePanel.currentPath(), ClipBoard.CLIP_COPY, activePanel.getReader() );
    }

    @Hint({ hint: T("Hint.Paste"), order: 7 })
    @Help( T("Help.Paste") )
    async clipboardPastePromise() {
        const activePanel = this.activePanel();
        const clipSelected = selection();
        
        let files = clipSelected.getFiles();
        if ( !files || files.length === 0 ) {
            log.debug( "CLIPBOARD Length: 0");
            return RefreshType.NONE;
        }

        if ( !(activePanel instanceof BlessedPanel) ) {
            return RefreshType.NONE;
        }

        const reader = activePanel.getReader();
        reader.isUserCanceled = false;

        const progressBox = new ProgressBox( { title: T("Message.Copy"), msg: T("Message.Calculating"), cancel: () => {
            reader.isUserCanceled = true;
        }}, { parent: this.baseWidget } );
        this.screen.render();
        await new Promise( (resolve) => setTimeout( () => resolve(), 1 ));
        
        if ( await clipSelected.expandDir() === false ) {
            progressBox.destroy();
            return RefreshType.NONE;
        }
        
        files = clipSelected.getFiles();

        // Sort in filename length ascending order.
        files.sort( (a, b) => a.fullname.length - b.fullname.length);

        const fullFileSize = files.reduce( (sum, item) => sum + item.size, 0 );
        const sourceBasePath = clipSelected.getSelecteBaseDir().fullname;

        let copyBytes = 0;
        let befCopyInfo = { beforeTime: Date.now(), copyBytes };
        
        let refreshTimeMs = 300;
        const progressStatus: ProgressFunc = ( source, copySize, size, chunkLength ) => {
            copyBytes += chunkLength;
            let repeatTime = Date.now() - befCopyInfo.beforeTime;
            if ( repeatTime > refreshTimeMs ) {
                let bytePerSec = Math.round((copyBytes - befCopyInfo.copyBytes) / repeatTime) * 1000;
                let lastText = (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(copyBytes, false, 1).trim()) + " / " + 
                                (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(fullFileSize, false, 1).trim());
                                // + `(${StringUtils.sizeConvert(bytePerSec, false, 1).trim()}s)`;
                progressBox.updateProgress( source.fullname, lastText, copyBytes, fullFileSize );
                befCopyInfo.beforeTime = Date.now();
                befCopyInfo.copyBytes = copyBytes;
            }
            return reader.isUserCanceled ? ProgressResult.USER_CANCELED : ProgressResult.SUCCESS;
        };

        if ( activePanel instanceof BlessedPanel ) {
            if ( files[0].dirname === activePanel.currentPath().fullname ) {
                log.error( "source file and target file are the same." );
                progressBox.destroy();
                await messageBox( {
                    parent: this.baseWidget,
                    title: T("Error"), 
                    msg: T("Message.SAME_SOURCE_AND_TARGET"), 
                    button: [ T("OK") ] 
                });
                return RefreshType.NONE;
            }
            
            const reader = activePanel.getReader();
            log.debug( "READER : [%s] => [%s]", reader.readerName, files[0].fstype );
            if ( files[0].fstype === "file" && reader.readerName === "file" && files[0].fstype === clipSelected.getReader().readerName ) {
                let targetPath = activePanel.currentPath();
                let i = 0, skipAll = false, overwriteAll = false;
                for ( let src of files ) {
                    if ( progressBox.getCanceled() ) {
                        break;
                    }
                    if ( !reader.exist(src.fullname) ) {
                        let result = await messageBox( {
                            parent: this.baseWidget,
                            title: T("Error"),
                            msg: T("{{filename}}_FILE_NOT_EXISTS", { filename: src.name }),
                            button: [ T("Skip"), T("Cancel") ]
                        });
                        if ( result === T("Cancel") ) {
                            break;
                        }
                        continue;
                    }

                    let targetBasePath = activePanel.currentPath().fullname;

                    let target = src.clone();
                    target.fullname = targetBasePath + target.fullname.substr(sourceBasePath.length);
                    
                    if ( !overwriteAll && reader.exist( target.fullname ) ) {
                        let result = await messageBox( {
                            parent: this.baseWidget,
                            title: T("Copy"),
                            msg: T("Message.{{filename}}_FILE_NOT_EXISTS", { filename: src.name }),
                            button: [ T("Overwrite"), T("Skip"), T("Rename"), T("Overwrite All"), T("Skip All") ]
                        });
                        
                        if ( result === T("Skip") ) {
                            continue;
                        }
                        if ( result === T("Overwrite All") ) {
                            overwriteAll = true;
                        }
                        if ( result === T("Skip All") ) {
                            break;
                        }
                        if ( result === T("Rename") ) {
                            const result = await inputBox( { 
                                parent: this.baseWidget,
                                title: T("Rename"),
                                defaultText: src.name,
                                button: [ T("OK"), T("Cancel") ]
                            });
                            if ( result && result[1] === T("OK") && result[0] ) {
                                target.fullname = targetBasePath + reader.sep() + result[0];
                            } else {
                                continue;   
                            }
                        }
                    }

                    try {
                        if ( src.dir ) {
                            log.debug( "COPY DIR - [%s] => [%s]", src.fullname, target.fullname );
                            reader.mkdir( target );
                        } else {
                            log.debug( "COPY - [%s] => [%s]", src.fullname, target.fullname );
                            await reader.copy( src, null, target, progressStatus );
                        }
                    } catch( err ) {
                        if ( err === "USER_CANCEL" ) {
                            break;
                        } else {
                            let result = await messageBox( {
                                parent: this.baseWidget,
                                title: T("Copy"),
                                msg: `${T("Error")}: ${src.name} - ${err}`,
                                button: [ T("OK"), T("Cancel") ]
                            });
                            if ( result === T("Cancel") ) {
                                break;
                            }
                        }
                    }
                }
            } else if ( files[0].fstype === clipSelected.getReader().readerName ) {
                try {
                    let reader = clipSelected.getReader().readerName !== "file" ? 
                        clipSelected.getReader() : activePanel.getReader();

                    await reader.copy( files, clipSelected.getSelecteBaseDir(), activePanel.currentPath(), progressStatus );
                } catch( err ) {
                    log.error( err );
                    progressBox.destroy();
                    await messageBox( {
                        parent: this.baseWidget,
                        title: T("Error"),
                        msg: err,
                        button: [ T("OK") ]
                    });
                    await this.refreshPromise();
                    return RefreshType.ALL;
                }
            }
        }

        progressBox.destroy();
        await this.refreshPromise();
        return RefreshType.ALL;
    }

    @Help(T("Help.Mkdir"))
    async mkdirPromise() {
        const panel = this.activePanel();
        if ( panel instanceof BlessedPanel ) {
            const reader = panel.getReader();
            const result = await inputBox( {
                parent: this.baseWidget,
                title: T("Message.MakeDirectory"),
                button: [ T("OK"), T("Cancel") ]
            }, {  });
            if ( result && result[1] === T("OK") && result[0] ) {
                
                if ( panel.getReader().readerName !== "file" ) {
                    const progressBox = new ProgressBox( { title: T("Message.Copy"), msg: T("Message.Calculating"), cancel: () => {
                        reader.isUserCanceled = true;
                    }}, { parent: this.baseWidget } );

                    try {
                        const reader = panel.getReader();
                        reader.isUserCanceled = false;

                        this.screen.render();
                        await new Promise( (resolve) => setTimeout( () => resolve(), 1 ));

                        let copyBytes = 0;
                        let befCopyInfo = { beforeTime: Date.now(), copyBytes };
                        let fullFileSize = 0;
                        let refreshTimeMs = 100;

                        const progressStatus: ProgressFunc = ( source, copySize, size, chunkLength ) => {
                            copyBytes += chunkLength;
                            let repeatTime = Date.now() - befCopyInfo.beforeTime;
                            if ( repeatTime > refreshTimeMs ) {
                                let bytePerSec = Math.round((copyBytes - befCopyInfo.copyBytes) / repeatTime) * 1000;
                                let lastText = (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(copyBytes, false, 1).trim()) + " / " + 
                                                (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(fullFileSize, false, 1).trim());
                                                // + `(${StringUtils.sizeConvert(bytePerSec, false, 1).trim()}s)`;
                                progressBox.updateProgress( source.fullname, lastText, copyBytes, fullFileSize );
                                befCopyInfo.beforeTime = Date.now();
                                befCopyInfo.copyBytes = copyBytes;
                            }
                            return reader.isUserCanceled ? ProgressResult.USER_CANCELED : ProgressResult.SUCCESS;
                        };
                        await reader.mkdir( panel.currentPath().fullname + reader.sep() + result[0], progressStatus );
                    } catch( e ) {
                        await messageBox( { parent: this.baseWidget, title: T("Error"), msg: e, button: [ T("OK") ] } );
                    } finally {
                        progressBox.destroy();
                    }
                } else {
                    try {
                        reader.mkdir( panel.currentPath().fullname + reader.sep() + result[0], null);
                    } catch( e ) {
                        await messageBox( { parent: this.baseWidget, title: T("Error"), msg: e, button: [ T("OK") ] } );
                    }
                }
            }
        }
        await this.refreshPromise();
        return RefreshType.ALL;
    }

    @Help(T("Help.Rename"))
    async renamePromise() {
        const panel = this.activePanel();
        if ( panel instanceof BlessedPanel ) {
            const reader = panel.getReader();
            const file = panel.currentFile();
            if ( file.dir && file.name === ".." ) {
                return RefreshType.NONE;
            }

            const result = await inputBox( {
                parent: this.baseWidget,
                title: T("Message.Rename"),
                defaultText: file.name,
                button: [ T("OK"), T("Cancel") ]
            }, {  });
            if ( result && result[1] === T("OK") && result[0] ) {
                const progressBox = new ProgressBox( { title: T("Message.Rename"), msg: T("Message.Calculating"), cancel: () => {
                    reader.isUserCanceled = true;
                }}, { parent: this.baseWidget } );

                try {
                    if ( reader.readerName !== "file ") {
                        let copyBytes = 0;
                        let befCopyInfo = { beforeTime: Date.now(), copyBytes };
                        let fullFileSize = 0;
                        let refreshTimeMs = 300;

                        this.screen.render();
                        await new Promise( (resolve) => setTimeout( () => resolve(), 1 ));

                        const progressStatus: ProgressFunc = ( source, copySize, size, chunkLength ) => {
                            copyBytes += chunkLength;
                            let repeatTime = Date.now() - befCopyInfo.beforeTime;
                            if ( repeatTime > refreshTimeMs ) {
                                let bytePerSec = Math.round((copyBytes - befCopyInfo.copyBytes) / repeatTime) * 1000;
                                let lastText = (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(copyBytes, false, 1).trim()) + " / " + 
                                                (new Color(3, 0)).fontHexBlessFormat(StringUtils.sizeConvert(fullFileSize, false, 1).trim());
                                                // + `(${StringUtils.sizeConvert(bytePerSec, false, 1).trim()}s)`;
                                progressBox.updateProgress( source.fullname, lastText, copyBytes, fullFileSize );
                                befCopyInfo.beforeTime = Date.now();
                                befCopyInfo.copyBytes = copyBytes;
                            }
                            return reader.isUserCanceled ? ProgressResult.USER_CANCELED : ProgressResult.SUCCESS;
                        };
                        await reader.rename( file, panel.currentPath().fullname + reader.sep() + result[0], progressStatus );
                    } else {
                        reader.rename( file, panel.currentPath().fullname + reader.sep() + result[0] );
                    }
                    panel.resetViewCache();
                } catch( e ) {
                    await messageBox( { parent: this.baseWidget, title: T("Error"), msg: e, button: [ T("OK") ] } );
                } finally {
                    progressBox.destroy();
                }
            }
        }
        await this.refreshPromise();
        return RefreshType.ALL;
    }

    @Hint({ hint: T( (os.platform() === "win32" ? "Hint.DriveList" : "Hint.MountList")), order: 7 })
    @Help( T(os.platform() === "win32" ? "Help.DriveList" : "Help.MountList") )
    async mountListPromise() {
        const panel = this.activePanel();
        if ( panel instanceof BlessedPanel ) {
            const mountList: IMountList[] = await panel.getReader().mountList();
            if ( mountList ) {
                let maxLength = [ 0, 0 ];
                mountList.sort( (a, b) => {
                    maxLength[0] = Math.max( maxLength[0], a.mountPath.fullname.length );
                    maxLength[1] = Math.max( maxLength[1], a.description.length );

                    if ( a.mountPath.fullname > b.mountPath.fullname ) return 1;
                    if ( b.mountPath.fullname > a.mountPath.fullname ) return -1;
                    return 0;
                });

                let viewMountInfo = mountList.map( (item) => {
                    return sprintf(`%-${maxLength[0] + 2}s | %-${maxLength[1] + 2}s | %s`, item.mountPath.fullname, item.description, StringUtils.sizeConvert(item.size, true));
                });

                log.debug( viewMountInfo );

                try {
                    const result = await messageBox( { parent: this.baseWidget, title: T("Message.MountList"), msg: "", button: viewMountInfo, buttonType: MSG_BUTTON_TYPE.VERTICAL } );
                    if ( result && viewMountInfo.indexOf(result) > -1 ) {
                        await panel.read( mountList[ viewMountInfo.indexOf(result) ].mountPath );
                        return RefreshType.ALL;
                    }
                } catch ( e ) {
                    log.error( e );
                }
            }
        }
        return RefreshType.NONE;
    }

    @Help(T("Help.Help"))
    async helpPromise() {
        const helpInfo: IHelpInfo = getHelpInfo();
        let viewText = [];
        for ( const frame of [ "Common", "Panel", "Mcd", "XTerm" ] ) {
            viewText.push(`${T(frame)})` );

            let subText = [];
            for ( const item in helpInfo[frame] ) {
                if ( helpInfo[frame][item].humanKeyName ) {
                    subText.push( sprintf("{yellow-fg}%14s{/yellow-fg} : %s", helpInfo[frame][item].humanKeyName, helpInfo[frame][item].text ) );
                }
            }
            subText.sort();
            
            viewText = viewText.concat( subText );
            viewText.push( "" );
        }

        log.debug( "viewText: %s", viewText );

        return new Promise( (resolve) => {
            setTimeout( async () => {
                await messageBox( {
                    parent: this.baseWidget,
                    title: T("HELP"),
                    msg: viewText.join("\n"),
                    textAlign: "left",
                    scroll: true,
                    button: [ T("OK") ]
                });
                resolve( RefreshType.ALL );
            }, 100);
        });
    }

    async imageViewPromise( file: File ) {
        if (process.env.TERM_PROGRAM === 'iTerm.app') {
            const buffer = await fs.promises.readFile(file.fullname);

            let iTermImage = (buffer, options: { width?: number | string, height?: number | string, preserveAspectRatio?: boolean } = {}) => {
                const OSC = '\u001B]';
                const BEL = '\u0007';
                let ret = `${OSC}1337;File=inline=1`;            
                if (options.width) {
                    ret += `;width=${options.width}`;
                }
            
                if (options.height) {
                    ret += `;height=${options.height}`;
                }
            
                if (options.preserveAspectRatio === false) {
                    ret += ';preserveAspectRatio=0';
                }
            
                return ret + ':' + buffer.toString('base64') + BEL;
            };

            await new Promise( (resolve, reject) => {
                let program = this.screen.program;
                this.screen.leave();
                process.stdout.write( iTermImage(buffer, { height: "95%" }) );
                process.stdout.write( "\n" + colors.white(T("Message.ANY_KEY_RETURN_M_JS")) + "\n" );
                program.once( 'keypress', () => {
                    resolve();
                });
            });
            this.screen.enter();
            await this.refreshPromise();
            this.execRefreshType( RefreshType.ALL );
        } else {
            setTimeout( async () => {
                let imageViewBox = new ImageViewBox( { parent: this.baseWidget } );
                this.screen.render();
                await imageViewBox.setImageOption({
                    file: file,
                    closeFunc: async () => {
                        log.debug( "CLOSE !!!");
                        this.execRefreshType( RefreshType.ALL );
                    }
                });
                this.screen.render();
            }, 100);
        }
    }

    static instance() {
        if ( !(global as any).gMainFrame ) {
            log.debug( "MAINFRAME() START !!!");
            (global as any).gMainFrame = new MainFrame();
        }
        return (global as any).gMainFrame;
    }
}

export default function mainFrame(): MainFrame {
    return MainFrame.instance();   
}
