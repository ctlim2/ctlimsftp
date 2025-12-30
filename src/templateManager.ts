import * as fs from 'fs';
import * as path from 'path';
import { SftpConfig } from './types';

export interface ServerTemplate {
    id: string;
    name: string;
    description?: string;
    config: Partial<SftpConfig>;
    createdAt: number;
    usageCount: number;
}

export class TemplateManager {
    private templatePath: string;
    private templates: ServerTemplate[] = [];

    constructor(workspaceRoot: string) {
        this.templatePath = path.join(workspaceRoot, '.vscode', '.sftp-templates.json');
        this.load();
    }

    private load(): void {
        if (fs.existsSync(this.templatePath)) {
            try {
                const content = fs.readFileSync(this.templatePath, 'utf-8');
                this.templates = JSON.parse(content);
            } catch (error) {
                console.error('Failed to load templates:', error);
                this.templates = [];
            }
        }
    }

    private save(): void {
        try {
            const dir = path.dirname(this.templatePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.templatePath, JSON.stringify(this.templates, null, 2));
        } catch (error) {
            console.error('Failed to save templates:', error);
        }
    }

    /**
     * 템플릿 추가
     */
    addTemplate(name: string, config: Partial<SftpConfig>, description?: string): ServerTemplate {
        // 민감한 정보는 제외 (password, privateKey 등)
        const cleanConfig: Partial<SftpConfig> = {
            port: config.port || 22,
            remotePath: config.remotePath || '/',
            uploadOnSave: config.uploadOnSave,
            downloadOnOpen: config.downloadOnOpen,
            downloadBackup: config.downloadBackup,
            ignore: config.ignore,
            context: config.context
        };

        const template: ServerTemplate = {
            id: `tpl_${Date.now()}`,
            name,
            description,
            config: cleanConfig,
            createdAt: Date.now(),
            usageCount: 0
        };

        this.templates.push(template);
        this.save();
        return template;
    }

    /**
     * 템플릿 삭제
     */
    removeTemplate(id: string): boolean {
        const index = this.templates.findIndex(t => t.id === id);
        if (index !== -1) {
            this.templates.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }

    /**
     * 모든 템플릿 조회
     */
    getAllTemplates(): ServerTemplate[] {
        return [...this.templates];
    }

    /**
     * 템플릿 사용 횟수 증가
     */
    incrementUsage(id: string): void {
        const template = this.templates.find(t => t.id === id);
        if (template) {
            template.usageCount++;
            this.save();
        }
    }

    /**
     * 자주 사용하는 템플릿
     */
    getFrequentTemplates(limit: number = 10): ServerTemplate[] {
        return [...this.templates]
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, limit);
    }

    /**
     * 템플릿으로 설정 생성
     */
    createConfigFromTemplate(template: ServerTemplate, host: string, username: string, password?: string, name?: string): SftpConfig {
        this.incrementUsage(template.id);

        return {
            name: name || `${username}@${host}`,
            host,
            port: template.config.port || 22,
            username,
            password,
            remotePath: template.config.remotePath || '/',
            uploadOnSave: template.config.uploadOnSave,
            downloadOnOpen: template.config.downloadOnOpen,
            downloadBackup: template.config.downloadBackup,
            ignore: template.config.ignore,
            context: template.config.context
        };
    }

    /**
     * 템플릿 다시 로드
     */
    reload(): void {
        this.load();
    }
}
