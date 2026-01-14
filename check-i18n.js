#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// i18n.ts에 정의된 모든 키 추출
const i18nPath = path.join(__dirname, 'src', 'i18n.ts');
const i18nContent = fs.readFileSync(i18nPath, 'utf-8');

// 정의된 키 추출: 'key': 'value' 형식
const definedKeysMatch = i18nContent.match(/'([^']+)':\s*['"`]/g);
const definedKeys = new Set();
if (definedKeysMatch) {
    definedKeysMatch.forEach(match => {
        const key = match.match(/'([^']+)'/)[1];
        definedKeys.add(key);
    });
}

console.log(`📚 정의된 총 i18n 키: ${definedKeys.size}`);

// src 폴더의 모든 .ts 파일에서 i18n.t() 호출 추출
const srcDir = path.join(__dirname, 'src');
const tsFiles = fs.readdirSync(srcDir).filter(file => file.endsWith('.ts'));

const usedKeys = new Set();
const usageMap = {}; // 키 -> [파일들]

tsFiles.forEach(file => {
    const filePath = path.join(srcDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // i18n.t('...') 또는 i18n.t("...") 형식 추출
    const matches = content.match(/i18n\.t\(['"`]([^'"`]+)['\"`]/g);
    if (matches) {
        matches.forEach(match => {
            const key = match.match(/i18n\.t\(['"`]([^'"`]+)/)[1];
            usedKeys.add(key);
            if (!usageMap[key]) usageMap[key] = [];
            usageMap[key].push(file);
        });
    }
});

console.log(`\n🔍 소스에서 사용된 총 i18n 키: ${usedKeys.size}`);

// 사용되지만 정의되지 않은 키 찾기
const missingKeys = Array.from(usedKeys).filter(key => !definedKeys.has(key)).sort();

if (missingKeys.length > 0) {
    console.log(`\n❌ 사용되지만 정의되지 않은 키 (${missingKeys.length}개):`);
    missingKeys.forEach(key => {
        const files = usageMap[key];
        console.log(`\n   - '${key}'`);
        console.log(`     위치: ${files.join(', ')}`);
    });
} else {
    console.log(`\n✅ 모든 사용된 키가 i18n.ts에 정의되어 있습니다!`);
}

// 정의되었지만 사용되지 않은 키 찾기 (선택사항)
const unusedKeys = Array.from(definedKeys).filter(key => !usedKeys.has(key)).sort();

if (unusedKeys.length > 0) {
    console.log(`\n⚠️  정의되었지만 사용되지 않은 키 (${unusedKeys.length}개):`);
    unusedKeys.slice(0, 20).forEach(key => console.log(`   - '${key}'`));
    if (unusedKeys.length > 20) {
        console.log(`   ... 그 외 ${unusedKeys.length - 20}개`);
    }
}

process.exit(missingKeys.length > 0 ? 1 : 0);
