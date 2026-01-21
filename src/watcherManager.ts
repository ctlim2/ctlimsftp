import * as vscode from 'vscode';
import { SftpConfig } from './types';
import { i18n } from './i18n';

/**
 * 활성 Watcher 정보를 담는 인터페이스
 */
interface ActiveWatcher {
    remotePath: string;
    serverName: string;
    watcher: { stop: () => void };
    outputChannel: vscode.OutputChannel;
    startTime: number;
}

/**
 * 전역 Watcher 관리자
 * 여러 파일의 로그 감시를 관리하고, 중복 감시를 방지하며, 정리 기능을 제공합니다.
 */
export class WatcherManager {
    private activeWatchers: Map<string, ActiveWatcher> = new Map();

    /**
     * Watcher 시작
     * @param key 고유 식별자 (예: "serverName:remotePath")
     * @param remotePath 원격 파일 경로
     * @param serverName 서버 이름
     * @param watcher watcher 객체 (stop 메서드 포함)
     * @param outputChannel 출력 채널
     */
    startWatch(
        key: string,
        remotePath: string,
        serverName: string,
        watcher: { stop: () => void },
        outputChannel: vscode.OutputChannel
    ): void {
        // 이미 감시 중인 경우 기존 것을 중지
        if (this.activeWatchers.has(key)) {
            this.stopWatch(key);
        }

        // 새로운 Watcher 등록
        this.activeWatchers.set(key, {
            remotePath,
            serverName,
            watcher,
            outputChannel,
            startTime: Date.now()
        });
    }

    /**
     * Watcher 중지
     * @param key 고유 식별자
     * @returns 중지 성공 여부
     */
    stopWatch(key: string): boolean {
        const activeWatcher = this.activeWatchers.get(key);
        if (!activeWatcher) {
            return false;
        }

        try {
            // Watcher 중지
            activeWatcher.watcher.stop();
            
            // OutputChannel에 중지 메시지 추가
            activeWatcher.outputChannel.appendLine('\n' + '-'.repeat(50));
            activeWatcher.outputChannel.appendLine('Log watch stopped.');
            
            // OutputChannel은 dispose하지 않고 유지 (사용자가 로그를 볼 수 있도록)
            
        } catch (error) {
            console.error('Error stopping watcher:', error);
        }

        // Map에서 제거
        this.activeWatchers.delete(key);
        return true;
    }

    /**
     * 모든 Watcher 중지
     */
    stopAllWatches(): void {
        const keys = Array.from(this.activeWatchers.keys());
        for (const key of keys) {
            this.stopWatch(key);
        }
    }

    /**
     * 특정 Watcher가 활성화되어 있는지 확인
     * @param key 고유 식별자
     * @returns 활성화 여부
     */
    hasActiveWatch(key: string): boolean {
        return this.activeWatchers.has(key);
    }

    /**
     * 모든 활성 Watcher 목록 반환
     * @returns 활성 Watcher 정보 배열
     */
    getActiveWatches(): Array<{ key: string; remotePath: string; serverName: string; startTime: number }> {
        const result: Array<{ key: string; remotePath: string; serverName: string; startTime: number }> = [];
        for (const [key, watcher] of this.activeWatchers) {
            result.push({
                key,
                remotePath: watcher.remotePath,
                serverName: watcher.serverName,
                startTime: watcher.startTime
            });
        }
        return result;
    }

    /**
     * 활성 Watcher 개수 반환
     * @returns 활성 Watcher 개수
     */
    getActiveWatchCount(): number {
        return this.activeWatchers.size;
    }

    /**
     * 리소스 정리 (Extension 비활성화 시 호출)
     */
    dispose(): void {
        this.stopAllWatches();
        this.activeWatchers.clear();
    }
}
