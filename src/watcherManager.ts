import * as vscode from 'vscode';
import { i18n } from './i18n';

/**
 * 활성화된 원격 파일 Watcher 정보
 */
export interface ActiveWatcher {
    id: string;
    remotePath: string;
    serverName: string;
    fileName: string;
    outputChannel: vscode.OutputChannel;
    watcher: { stop: () => void };
    startTime: number;
}

/**
 * 전역 Watcher 관리자
 * 모든 활성화된 원격 파일 감시를 중앙에서 관리
 */
export class WatcherManager {
    private watchers: Map<string, ActiveWatcher> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private readonly DEBUG_MODE: boolean;

    constructor(debugMode: boolean = false) {
        this.DEBUG_MODE = debugMode;
        
        // Status bar item 생성
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right, 
            100
        );
        this.statusBarItem.command = 'ctlimSftp.manageWatchers';
        this.updateStatusBar();
    }

    /**
     * 새 Watcher 추가
     */
    addWatcher(
        remotePath: string,
        serverName: string,
        fileName: string,
        outputChannel: vscode.OutputChannel,
        watcher: { stop: () => void }
    ): string {
        const id = this.generateWatcherId(remotePath, serverName);
        
        // 이미 같은 파일을 감시 중이면 기존 것을 중지
        if (this.watchers.has(id)) {
            if (this.DEBUG_MODE) {
                console.log(`Stopping existing watcher for ${remotePath}`);
            }
            this.stopWatcher(id);
        }

        const activeWatcher: ActiveWatcher = {
            id,
            remotePath,
            serverName,
            fileName,
            outputChannel,
            watcher,
            startTime: Date.now()
        };

        this.watchers.set(id, activeWatcher);
        this.updateStatusBar();

        if (this.DEBUG_MODE) {
            console.log(`Added watcher for ${remotePath} on ${serverName}`);
        }

        return id;
    }

    /**
     * Watcher 중지
     */
    stopWatcher(id: string): boolean {
        const activeWatcher = this.watchers.get(id);
        if (!activeWatcher) {
            return false;
        }

        try {
            activeWatcher.watcher.stop();
            activeWatcher.outputChannel.appendLine('\n' + '-'.repeat(50));
            activeWatcher.outputChannel.appendLine('Log watch stopped by user.');
            
            this.watchers.delete(id);
            this.updateStatusBar();

            if (this.DEBUG_MODE) {
                console.log(`Stopped watcher for ${activeWatcher.remotePath}`);
            }

            return true;
        } catch (error) {
            if (this.DEBUG_MODE) {
                console.error(`Error stopping watcher: ${error}`);
            }
            return false;
        }
    }

    /**
     * 모든 Watcher 중지
     */
    stopAllWatchers(): void {
        const ids = Array.from(this.watchers.keys());
        ids.forEach(id => this.stopWatcher(id));
        
        if (this.DEBUG_MODE) {
            console.log('Stopped all watchers');
        }
    }

    /**
     * 활성 Watcher 목록 가져오기
     */
    getActiveWatchers(): ActiveWatcher[] {
        return Array.from(this.watchers.values());
    }

    /**
     * 특정 Watcher 가져오기
     */
    getWatcher(id: string): ActiveWatcher | undefined {
        return this.watchers.get(id);
    }

    /**
     * 활성 Watcher 개수
     */
    getActiveCount(): number {
        return this.watchers.size;
    }

    /**
     * Watcher ID 생성
     */
    private generateWatcherId(remotePath: string, serverName: string): string {
        return `${serverName}:${remotePath}`;
    }

    /**
     * Status bar 업데이트
     */
    private updateStatusBar(): void {
        const count = this.watchers.size;
        
        if (count === 0) {
            this.statusBarItem.hide();
        } else {
            this.statusBarItem.text = `$(eye) ${count}`;
            this.statusBarItem.tooltip = i18n.t('statusBar.activeWatchers', { count });
            this.statusBarItem.show();
        }
    }

    /**
     * Quick Pick으로 Watcher 관리 UI 표시
     */
    async showManageWatchersUI(): Promise<void> {
        const watchers = this.getActiveWatchers();
        
        if (watchers.length === 0) {
            vscode.window.showInformationMessage(i18n.t('info.noActiveWatchers'));
            return;
        }

        // Watcher 목록을 QuickPick items로 변환
        // Store watcher ID as a custom property by extending QuickPickItem
        interface WatcherQuickPickItem extends vscode.QuickPickItem {
            watcherId: string;
        }

        const items: WatcherQuickPickItem[] = watchers.map(w => {
            const duration = Math.floor((Date.now() - w.startTime) / 1000);
            const minutes = Math.floor(duration / 60);
            const seconds = duration % 60;
            const durationStr = minutes > 0 
                ? `${minutes}m ${seconds}s` 
                : `${seconds}s`;
            
            return {
                label: w.fileName,
                description: w.serverName,
                detail: `${w.remotePath} (${i18n.t('label.duration')}: ${durationStr})`,
                iconPath: new vscode.ThemeIcon('eye'),
                watcherId: w.id
            };
        });

        // "Stop All" 옵션 추가
        items.push({
            label: `$(stop-circle) ${i18n.t('action.stopAllWatchers')}`,
            description: '',
            detail: i18n.t('description.stopAllWatchers'),
            watcherId: '__STOP_ALL__'
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: i18n.t('prompt.selectWatcherToStop'),
            canPickMany: false
        });

        if (!selected) {
            return;
        }

        // "Stop All" 선택
        if (selected.watcherId === '__STOP_ALL__') {
            const confirm = await vscode.window.showWarningMessage(
                i18n.t('confirm.stopAllWatchers'),
                { modal: true },
                i18n.t('action.stop')
            );
            
            if (confirm === i18n.t('action.stop')) {
                this.stopAllWatchers();
                vscode.window.showInformationMessage(i18n.t('info.allWatchersStopped'));
            }
            return;
        }

        // 개별 Watcher 중지 - ID를 사용하여 정확하게 식별
        const watcherToStop = watchers.find(w => w.id === selected.watcherId);
        
        if (watcherToStop) {
            const stopped = this.stopWatcher(watcherToStop.id);
            if (stopped) {
                vscode.window.showInformationMessage(
                    i18n.t('info.watcherStopped', { fileName: watcherToStop.fileName })
                );
            }
        }
    }

    /**
     * Dispose - 모든 리소스 정리
     */
    dispose(): void {
        this.stopAllWatchers();
        this.statusBarItem.dispose();
        
        if (this.DEBUG_MODE) {
            console.log('WatcherManager disposed');
        }
    }
}
