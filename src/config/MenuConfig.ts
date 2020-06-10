
export interface ISubMenuConfig {
    name: string;
    method ?: string;
    funcParam ?: any[];
    key ?: string;
}

export interface IMainMenuConfig {
    [mainMenu: string]: (ISubMenuConfig | string)[]
}

export interface IFrameMenuConfig {
    [frame: string]: IMainMenuConfig;
}

export const menuConfig: IFrameMenuConfig = {
    Panel: {
        "Mdir.js": [ 
            { name: "About", method: "Common.about" },
            { name: "Help", method: "Panel.help" },
            "-",
            { name: "Settings" },
            "-",
            { name: "Quit", method: "Common.quit" }
        ],
        Run: [
            { name: "Run", method: "Panel.keyEnterPromise" },
            { name: "Run(select)" },
            "-",
            { name: "View Console", method: "Common.consoleViewPromise" }
        ],
        File: [
            { name : "New" },
            "-",
            { name: "Copy", method: "Common.clipboardCopy" },
            { name: "Cut", method: "Common.clipboardCut" },
            { name: "Paste", method: "Common.clipboardPastePromise" },
            "-",
            { name: "Find" },
            { name: "Diff" }
        ],
        Directory: [
            { name: "Mcd", method: "Common.mcdPromise" },
            { name: "Qcd" },
            "-",
            { name: "Mkdir" },
            { name: "To parent" },
            { name: "To root" },
            { name: "To home" },
            "-",
            { name: "Back" },
            { name: "Forward" }
        ],
        View: [
            { name: "Refresh", method: "Common.refreshPromise" },
            { name: "Column AUTO", method: "Panel.setViewColumn", funcParam: [ 0 ] },
            "-",
            { name: "Column 1", method: "Panel.setViewColumn", funcParam: [ 1 ] },
            { name: "Column 2", method: "Panel.setViewColumn", funcParam: [ 2 ] },
            { name: "Column 3", method: "Panel.setViewColumn", funcParam: [ 3 ] },
            { name: "Column 4", method: "Panel.setViewColumn", funcParam: [ 4 ] },
            "-",
            { name: "Hidden file on/off" },
            { name: "Owner show on/off" },
            { name: "Sort change" },
            { name: "Sort Asc/Descend" },
            "-",
            { name: "Split", method: "Common.split" },
            { name: "Next Window", method: "Common.nextWindow" }
        ]
    }
};

