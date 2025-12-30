import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TransferHistory, TransferStatistics } from './types';

const DEBUG_MODE = true;

export class TransferHistoryManager {
    private historyFile: string;
    private maxHistorySize: number = 100;
    
    constructor(workspaceRoot: string) {
        const historyDir = path.join(workspaceRoot, '.vscode');
        if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
        }
        this.historyFile = path.join(historyDir, '.sftp-history.json');
    }
    
    /**
     * 전송 기록 추가
     */
    addHistory(history: TransferHistory): void {
        try {
            const histories = this.loadHistories();
            histories.unshift(history);  // 최신 항목을 앞에 추가
            
            // 최대 개수 제한
            if (histories.length > this.maxHistorySize) {
                histories.splice(this.maxHistorySize);
            }
            
            this.saveHistories(histories);
            
            if (DEBUG_MODE) {
                console.log(`Transfer history added: ${history.type} ${history.status} - ${path.basename(history.localPath)}`);
            }
        } catch (error) {
            console.error('Failed to add transfer history:', error);
        }
    }
    
    /**
     * 모든 전송 기록 로드
     */
    loadHistories(): TransferHistory[] {
        try {
            if (!fs.existsSync(this.historyFile)) {
                return [];
            }
            
            const content = fs.readFileSync(this.historyFile, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            console.error('Failed to load transfer history:', error);
            return [];
        }
    }
    
    /**
     * 전송 기록 저장
     */
    private saveHistories(histories: TransferHistory[]): void {
        try {
            fs.writeFileSync(this.historyFile, JSON.stringify(histories, null, 2));
        } catch (error) {
            console.error('Failed to save transfer history:', error);
        }
    }
    
    /**
     * 실패한 전송만 조회
     */
    getFailedTransfers(): TransferHistory[] {
        const histories = this.loadHistories();
        return histories.filter(h => h.status === 'failed');
    }
    
    /**
     * 특정 서버의 전송 기록 조회
     */
    getHistoriesByServer(serverName: string): TransferHistory[] {
        const histories = this.loadHistories();
        return histories.filter(h => h.serverName === serverName);
    }
    
    /**
     * 전송 통계 계산
     */
    getStatistics(serverName?: string): TransferStatistics {
        let histories = this.loadHistories();
        
        if (serverName) {
            histories = histories.filter(h => h.serverName === serverName);
        }
        
        const stats: TransferStatistics = {
            totalUploads: histories.filter(h => h.type === 'upload').length,
            totalDownloads: histories.filter(h => h.type === 'download').length,
            totalBytes: histories.reduce((sum, h) => sum + h.fileSize, 0),
            successCount: histories.filter(h => h.status === 'success').length,
            failedCount: histories.filter(h => h.status === 'failed').length,
            averageSpeed: 0
        };
        
        // 평균 전송 속도 계산
        const speedHistories = histories.filter(h => h.transferSpeed && h.transferSpeed > 0);
        if (speedHistories.length > 0) {
            const totalSpeed = speedHistories.reduce((sum, h) => sum + (h.transferSpeed || 0), 0);
            stats.averageSpeed = totalSpeed / speedHistories.length;
        }
        
        return stats;
    }
    
    /**
     * 전송 기록 삭제
     */
    clearHistory(): void {
        try {
            if (fs.existsSync(this.historyFile)) {
                fs.unlinkSync(this.historyFile);
            }
        } catch (error) {
            console.error('Failed to clear transfer history:', error);
        }
    }
    
    /**
     * 특정 전송 기록 제거
     */
    removeHistory(id: string): void {
        try {
            let histories = this.loadHistories();
            histories = histories.filter(h => h.id !== id);
            this.saveHistories(histories);
        } catch (error) {
            console.error('Failed to remove transfer history:', error);
        }
    }
}

/**
 * 전송 기록 생성 헬퍼
 */
export function createTransferHistory(
    type: 'upload' | 'download' | 'sync',
    status: 'success' | 'failed' | 'cancelled',
    localPath: string,
    remotePath: string,
    fileSize: number,
    duration: number,
    serverName: string,
    errorMessage?: string
): TransferHistory {
    const transferSpeed = duration > 0 ? (fileSize / duration) * 1000 : 0;  // bytes/sec
    
    return {
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        status,
        localPath,
        remotePath,
        fileSize,
        transferSpeed,
        duration,
        timestamp: Date.now(),
        errorMessage,
        serverName
    };
}
