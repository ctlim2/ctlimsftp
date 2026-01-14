import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SftpConfig } from './types';
import { i18n } from './i18n';

export class ConnectConfigWebview {
    public static currentPanel: ConnectConfigWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Webview 내용 설정
        this._update();

        // 패널이 닫힐 때 정리
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 메시지 수신 처리
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveConfig':
                        await this._saveConfig(message.data);
                        return;
                    case 'loadConfig':
                        await this._loadConfig();
                        return;
                    case 'showError':
                        vscode.window.showErrorMessage(message.text);
                        return;
                    case 'showInfo':
                        vscode.window.showInformationMessage(message.text);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 이미 패널이 있으면 보이기
        if (ConnectConfigWebview.currentPanel) {
            ConnectConfigWebview.currentPanel._panel.reveal(column);
            return;
        }

        // 새 패널 생성
        const panel = vscode.window.createWebviewPanel(
            'ctlimSftpConfig',
            'SFTP Configuration',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
            }
        );

        ConnectConfigWebview.currentPanel = new ConnectConfigWebview(panel, extensionUri);
    }

    public dispose() {
        ConnectConfigWebview.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private async _loadConfig() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            this._panel.webview.postMessage({ command: 'configLoaded', data: [] });
            return;
        }

        const configPath = path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'ctlim-sftp.json');
        
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(content);
                const configArray = Array.isArray(config) ? config : [config];
                this._panel.webview.postMessage({ command: 'configLoaded', data: configArray });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to load config: ${error}`);
                this._panel.webview.postMessage({ command: 'configLoaded', data: [] });
            }
        } else {
            // 기본 템플릿 제공
            this._panel.webview.postMessage({ command: 'configLoaded', data: [] });
        }
    }

    private async _saveConfig(data: any) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage(i18n.t('error.noWorkspace'));
            return;
        }

        const vscodeDir = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }

        const configPath = path.join(vscodeDir, 'ctlim-sftp.json');
        
        try {
            // 정수형 변환 등 데이터 정제
            const configs = Array.isArray(data) ? data : [data];
            const cleanConfigs = configs.map((cfg: any) => ({
                ...cfg,
                port: parseInt(cfg.port) || 22,
                uploadOnSave: !!cfg.uploadOnSave,
                downloadOnOpen: cfg.downloadOnOpen === 'confirm' ? 'confirm' : !!cfg.downloadOnOpen
            }));

            fs.writeFileSync(configPath, JSON.stringify(cleanConfigs, null, 4), 'utf8');
            vscode.window.showInformationMessage('SFTP Configuration saved successfully!');
            
            // 설정 변경 알림 (Extension에서 감지하여 리로드하도록)
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save config: ${error}`);
        }
    }

    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SFTP Configuration</title>
    <style>
        body { padding: 20px; font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        .container { max-width: 800px; margin: 0 auto; }
        .server-list { margin-bottom: 20px; border: 1px solid var(--vscode-panel-border); }
        .server-item { padding: 10px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; }
        .server-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .server-item.active { background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input[type="text"], input[type="password"], input[type="number"], select { width: 100%; padding: 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
        .checkbox-group { display: flex; align-items: center; }
        .checkbox-group input { width: auto; margin-right: 10px; }
        .btn { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; border-radius: 2px; margin-right: 10px; }
        .btn:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-danger { background-color: var(--vscode-errorForeground); }
        .toolbar { margin-bottom: 20px; display: flex; gap: 10px; }
        .hidden { display: none; }
        .tabs { display: flex; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
        .tab { padding: 10px 20px; cursor: pointer; border-bottom: 2px solid transparent; }
        .tab.active { border-bottom-color: var(--vscode-progressBar-background); font-weight: bold; }
        
        /* Modal Styles */
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.4); }
        .modal-content { background-color: var(--vscode-editor-background); margin: 5% auto; padding: 20px; border: 1px solid var(--vscode-panel-border); width: 80%; max-width: 800px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
        .close { color: var(--vscode-foreground); float: right; font-size: 28px; font-weight: bold; cursor: pointer; }
        .close:hover, .close:focus { color: var(--vscode-textLink-activeForeground); text-decoration: none; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h2>SFTP Server Configuration</h2>
        
        <div class="toolbar">
            <button class="btn" id="addServerBtn">Add New Server</button>
            <button class="btn btn-secondary" id="saveAllBtn">Save All Configs</button>
        </div>

        <div class="server-list" id="serverList"></div>

        <!-- Editor Modal -->
        <div id="editModal" class="modal">
            <div class="modal-content">
                <span class="close" id="closeModalSpan">&times;</span>
                <h2 id="modalTitle">Edit Server</h2>

                <div id="editorArea">
                    <div class="tabs">
                        <div class="tab active" data-tab="basic">Basic</div>
                        <div class="tab" data-tab="advanced">Advanced (Watch/Ignore)</div>
                    </div>

                    <div id="basicTab" class="tab-content">
                        <div class="form-group">
                            <label>Server Name (Alias)</label>
                            <input type="text" id="name" placeholder="My Dev Server">
                        </div>
                        <div class="form-group">
                            <label>Group</label>
                            <input type="text" id="group" placeholder="Development">
                        </div>
                        <div class="form-group">
                            <label>Protocol</label>
                            <select id="protocol">
                                <option value="sftp">SFTP</option>
                                <option value="ftp">FTP</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Host</label>
                            <input type="text" id="host" placeholder="example.com">
                        </div>
                        <div class="form-group">
                            <label>Port</label>
                            <input type="number" id="port" value="22">
                        </div>
                        <div class="form-group">
                            <label>Username</label>
                            <input type="text" id="username" placeholder="root">
                        </div>
                        <div class="form-group">
                            <label>Password (Optional)</label>
                            <input type="password" id="password" placeholder="Leave empty to prompt on connect">
                        </div>
                        <div class="form-group">
                            <label>Private Key Path (Optional)</label>
                            <input type="text" id="privateKey" placeholder="/path/to/private/key">
                        </div>
                        <div class="form-group">
                            <label>Remote Path</label>
                            <input type="text" id="remotePath" placeholder="/var/www/html" value="/">
                        </div>
                        <div class="form-group checkbox-group">
                            <input type="checkbox" id="uploadOnSave">
                            <label for="uploadOnSave" style="margin:0">Upload On Save (Auto Upload)</label>
                        </div>
                    </div>

                    <div id="advancedTab" class="tab-content hidden">
                        <div class="form-group">
                            <label>Context (Local Root)</label>
                            <input type="text" id="context" value="./" placeholder="./">
                        </div>
                        <div class="form-group">
                            <label>Download On Open</label>
                            <select id="downloadOnOpen">
                                <option value="false">Disabled</option>
                                <option value="true">Enabled (Auto)</option>
                                <option value="confirm">Confirm</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Ignore Patterns (Comma separated)</label>
                            <input type="text" id="ignore" placeholder=".git, node_modules, .vscode">
                        </div>
                        <div class="form-group">
                            <label>Web URL (for Open in Browser)</label>
                            <input type="text" id="webUrl" placeholder="http://example.com">
                        </div>
                    </div>

                    <div style="margin-top: 20px; border-top: 1px solid var(--vscode-panel-border); padding-top: 20px; display: flex; justify-content: space-between;">
                         <button class="btn btn-danger" id="deleteServerBtn">Delete This Server</button>
                         <div>
                            <button class="btn" id="modalOkBtn">OK</button>
                            <button class="btn btn-secondary" id="modalCancelBtn">Cancel</button>
                         </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let configs = [];
        let currentIndex = -1;

        // Initialize
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'configLoaded':
                    configs = message.data;
                    renderServerList();
                    break;
            }
        });

        // Request config load on start
        vscode.postMessage({ command: 'loadConfig' });

        // DOM Elements
        const serverList = document.getElementById('serverList');
        const modal = document.getElementById('editModal');
        const closeModalSpan = document.getElementById('closeModalSpan');
        const modalCancelBtn = document.getElementById('modalCancelBtn');
        const modalOkBtn = document.getElementById('modalOkBtn');
        
        // Modal Actions
        function openModal() {
            modal.style.display = "block";
        }
        function closeModal() {
            modal.style.display = "none";
        }
        closeModalSpan.onclick = closeModal;
        modalCancelBtn.onclick = closeModal;
        window.onclick = function(event) {
            if (event.target == modal) {
                closeModal();
            }
        }
        
        modalOkBtn.onclick = () => {
            saveCurrentEditorData();
            closeModal();
            renderServerList();
        };

        // Tab Handling
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
                
                tab.classList.add('active');
                const tabId = tab.dataset.tab + 'Tab';
                document.getElementById(tabId).classList.remove('hidden');
            });
        });

        // Add Server
        document.getElementById('addServerBtn').addEventListener('click', () => {
            const newConfig = {
                name: 'New Server',
                protocol: 'sftp',
                host: '',
                port: 22,
                username: '',
                remotePath: '/',
                context: './',
                uploadOnSave: true,
                downloadOnOpen: false,
                ignore: ['.git', '.vscode', 'node_modules']
            };
            configs.push(newConfig);
            selectServer(configs.length - 1);
        });

        // Delete Server
        document.getElementById('deleteServerBtn').addEventListener('click', () => {
            if (currentIndex > -1) {
                if(confirm('Are you sure you want to delete this server configuration?')) {
                    configs.splice(currentIndex, 1);
                    closeModal();
                    renderServerList();
                }
            }
        });

        // Save All
        document.getElementById('saveAllBtn').addEventListener('click', () => {
            vscode.postMessage({
                command: 'saveConfig',
                data: configs
            });
        });

        function renderServerList() {
            serverList.innerHTML = '';
            configs.forEach((config, index) => {
                const div = document.createElement('div');
                div.className = 'server-item';
                
                // Item content
                const infoDiv = document.createElement('div');
                infoDiv.style.flex = '1';
                infoDiv.innerHTML = \`
                    <span>\${config.name || config.host || 'Unnamed Server'}</span>
                    <small>\${config.host}</small>
                \`;
                infoDiv.onclick = () => selectServer(index);
                
                // Edit icon (pencil)
                const editIcon = document.createElement('span');
                editIcon.innerHTML = '✏️'; 
                editIcon.style.cursor = 'pointer';
                editIcon.style.padding = '5px';
                editIcon.title = 'Edit Server';
                editIcon.onclick = (e) => {
                    e.stopPropagation();
                    selectServer(index);
                };
                
                div.appendChild(infoDiv);
                div.appendChild(editIcon);
                serverList.appendChild(div);
            });
        }

        function selectServer(index) {
            currentIndex = index;
            loadEditorData(configs[index]);
            openModal();
        }

        function loadEditorData(config) {
            document.getElementById('name').value = config.name || '';
            document.getElementById('group').value = config.group || '';
            document.getElementById('protocol').value = config.protocol || 'sftp';
            document.getElementById('host').value = config.host || '';
            document.getElementById('port').value = config.port || 22;
            document.getElementById('username').value = config.username || '';
            document.getElementById('password').value = config.password || '';
            document.getElementById('privateKey').value = config.privateKey || '';
            document.getElementById('remotePath').value = config.remotePath || '/';
            document.getElementById('uploadOnSave').checked = !!config.uploadOnSave;
            
            document.getElementById('context').value = config.context || './';
            document.getElementById('downloadOnOpen').value = String(config.downloadOnOpen || 'false');
            document.getElementById('webUrl').value = config.webUrl || '';
            
            if (Array.isArray(config.ignore)) {
                document.getElementById('ignore').value = config.ignore.join(', ');
            } else {
                document.getElementById('ignore').value = '';
            }
        }

        function saveCurrentEditorData() {
            if (currentIndex === -1 || !configs[currentIndex]) return;

            const config = configs[currentIndex];
            config.name = document.getElementById('name').value;
            config.group = document.getElementById('group').value;
            config.protocol = document.getElementById('protocol').value;
            config.host = document.getElementById('host').value;
            config.port = parseInt(document.getElementById('port').value);
            config.username = document.getElementById('username').value;
            
            const pass = document.getElementById('password').value;
            if (pass) config.password = pass;
            
            const pk = document.getElementById('privateKey').value;
            if (pk) config.privateKey = pk;
            else delete config.privateKey;

            config.remotePath = document.getElementById('remotePath').value;
            config.uploadOnSave = document.getElementById('uploadOnSave').checked;
            config.context = document.getElementById('context').value;
            
            const dl = document.getElementById('downloadOnOpen').value;
            if (dl === 'true') config.downloadOnOpen = true;
            else if (dl === 'false') config.downloadOnOpen = false;
            else config.downloadOnOpen = 'confirm';

            config.webUrl = document.getElementById('webUrl').value;
            
            const ignoreStr = document.getElementById('ignore').value;
            if (ignoreStr) {
                config.ignore = ignoreStr.split(',').map(s => s.trim()).filter(s => s);
            } else {
                config.ignore = [];
            }
        }
    </script>
</body>
</html>`;
    }
}
