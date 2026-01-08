import * as fs from 'fs';
import * as path from 'path';
import { Bookmark } from './types';

/**
 * 북마크 관리자
 * 자주 사용하는 원격 경로를 저장하고 관리합니다.
 */
export class BookmarkManager {
    private bookmarksFilePath: string;
    private bookmarks: Bookmark[] = [];

    constructor(workspaceRoot: string) {
        const bookmarksDir = path.join(workspaceRoot, '.vscode');
        if (!fs.existsSync(bookmarksDir)) {
            fs.mkdirSync(bookmarksDir, { recursive: true });
        }
        
        this.bookmarksFilePath = path.join(bookmarksDir, '.sftp-bookmarks.json');
        this.loadBookmarks();
    }

    /**
     * 북마크 목록 로드
     */
    private loadBookmarks(): void {
        try {
            if (fs.existsSync(this.bookmarksFilePath)) {
                const content = fs.readFileSync(this.bookmarksFilePath, 'utf-8');
                this.bookmarks = JSON.parse(content);
            }
        } catch (error) {
            console.error('북마크 로드 실패:', error);
            this.bookmarks = [];
        }
    }

    /**
     * 북마크 목록 다시 로드 (외부 호출용)
     */
    reload(): void {
        this.loadBookmarks();
    }

    /**
     * 북마크 목록 저장
     */
    private saveBookmarks(): void {
        try {
            fs.writeFileSync(
                this.bookmarksFilePath,
                JSON.stringify(this.bookmarks, null, 2),
                'utf-8'
            );
        } catch (error) {
            console.error('북마크 저장 실패:', error);
        }
    }

    /**
     * 북마크 추가
     */
    addBookmark(
        name: string,
        serverName: string,
        remotePath: string,
        isDirectory: boolean,
        description?: string,
        groupName?: string,
        protocol?: 'sftp' | 'ftp' | 'ftps'
    ): Bookmark {
        const bookmark: Bookmark = {
            id: Date.now().toString(),
            name,
            serverName,
            groupName,
            protocol,
            remotePath,
            isDirectory,
            description,
            createdAt: Date.now(),
            accessCount: 0
        };

        this.bookmarks.push(bookmark);
        this.saveBookmarks();
        
        return bookmark;
    }

    /**
     * 북마크 삭제
     */
    removeBookmark(bookmarkId: string): boolean {
        const index = this.bookmarks.findIndex(b => b.id === bookmarkId);
        if (index !== -1) {
            this.bookmarks.splice(index, 1);
            this.saveBookmarks();
            return true;
        }
        return false;
    }

    /**
     * 북마크 업데이트
     */
    updateBookmark(bookmarkId: string, updates: Partial<Bookmark>): boolean {
        const bookmark = this.bookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
            Object.assign(bookmark, updates);
            this.saveBookmarks();
            return true;
        }
        return false;
    }

    /**
     * 북마크 접근 시 통계 업데이트
     */
    recordAccess(bookmarkId: string): void {
        const bookmark = this.bookmarks.find(b => b.id === bookmarkId);
        if (bookmark) {
            bookmark.lastAccessedAt = Date.now();
            bookmark.accessCount++;
            this.saveBookmarks();
        }
    }

    /**
     * 모든 북마크 조회
     */
    getAllBookmarks(): Bookmark[] {
        return [...this.bookmarks];
    }

    /**
     * 서버별 북마크 조회
     */
    getBookmarksByServer(serverName: string): Bookmark[] {
        return this.bookmarks.filter(b => b.serverName === serverName);
    }

    /**
     * 자주 사용하는 북마크 조회 (상위 10개)
     */
    getFrequentBookmarks(limit: number = 10): Bookmark[] {
        return [...this.bookmarks]
            .sort((a, b) => b.accessCount - a.accessCount)
            .slice(0, limit);
    }

    /**
     * 최근 사용한 북마크 조회 (상위 10개)
     */
    getRecentBookmarks(limit: number = 10): Bookmark[] {
        return [...this.bookmarks]
            .filter(b => b.lastAccessedAt)
            .sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0))
            .slice(0, limit);
    }

    /**
     * 북마크 검색
     */
    searchBookmarks(query: string): Bookmark[] {
        const lowerQuery = query.toLowerCase();
        return this.bookmarks.filter(b =>
            b.name.toLowerCase().includes(lowerQuery) ||
            b.remotePath.toLowerCase().includes(lowerQuery) ||
            b.serverName.toLowerCase().includes(lowerQuery) ||
            (b.description && b.description.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * 북마크 존재 여부 확인
     */
    hasBookmark(serverName: string, remotePath: string): boolean {
        return this.bookmarks.some(
            b => b.serverName === serverName && b.remotePath === remotePath
        );
    }

    /**
     * 북마크 ID로 조회
     */
    getBookmarkById(bookmarkId: string): Bookmark | undefined {
        return this.bookmarks.find(b => b.id === bookmarkId);
    }

    /**
     * 모든 북마크 삭제
     */
    clearAllBookmarks(): void {
        this.bookmarks = [];
        this.saveBookmarks();
    }

    /**
     * 고유 ID 생성
     */
    private generateId(): string {
        return `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
}
