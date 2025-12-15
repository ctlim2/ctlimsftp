# Architecture Overview / 아키텍처 개요

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        VSCode Extension                          │
│                                                                   │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐ │
│  │   extension.ts │  │ fileMetadata    │  │   sftpClient.ts  │ │
│  │                │  │   Tracker.ts    │  │                  │ │
│  │  - activate()  │  │                 │  │  - connect()     │ │
│  │  - download()  │─▶│  - store()      │  │  - stat()        │ │
│  │  - upload()    │  │  - get()        │  │  - download()    │ │
│  │  - configure() │  │  - remove()     │  │  - upload()      │ │
│  └────────────────┘  └─────────────────┘  └──────────────────┘ │
│         │                     │                      │           │
└─────────┼─────────────────────┼──────────────────────┼───────────┘
          │                     │                      │
          │                     │                      │
          │                     ▼                      │
          │          ┌──────────────────┐             │
          │          │  VSCode Storage  │             │
          │          │  (Workspace      │             │
          │          │   State)         │             │
          │          └──────────────────┘             │
          │                                            │
          └────────────────────────────────────────────┘
                                │
                                ▼
                   ┌────────────────────────┐
                   │    SFTP Server         │
                   │                        │
                   │  - File Storage        │
                   │  - Metadata (mtime,    │
                   │    size)               │
                   └────────────────────────┘
```

## Component Details

### 1. extension.ts (Main Logic)
**Responsibilities:**
- Extension activation and command registration
- User interaction (dialogs, input boxes)
- Orchestration of file operations
- Modification detection and warning logic

**Key Functions:**
- `downloadFile()`: Downloads file and stores metadata
- `uploadFile()`: Checks modifications before upload
- `configureConnection()`: Sets up SFTP connection

### 2. fileMetadataTracker.ts (Metadata Management)
**Responsibilities:**
- Store file metadata in VSCode workspace state
- Retrieve metadata for comparison
- Clean up old metadata

**Data Structure:**
```typescript
{
  "/local/path/file.txt": {
    remotePath: "/remote/path/file.txt",
    mtime: 1705311600000,
    size: 1024
  }
}
```

### 3. sftpClient.ts (SFTP Operations)
**Responsibilities:**
- Wrapper around ssh2-sftp-client
- Connection management
- File operations (get, put, stat)

**Dependencies:**
- ssh2-sftp-client
- ssh2

## Data Flow: File Download

```
User                Extension            FileMetadataTracker    SftpClient    Server
 │                      │                        │                 │           │
 │─Download Command────▶│                        │                 │           │
 │                      │                        │                 │           │
 │                      │────connect()──────────────────────────▶│           │
 │                      │                        │                 │───SSH───▶│
 │                      │                        │                 │◀──────────│
 │                      │◀──────────────────────────────────────────────────│
 │                      │                        │                 │           │
 │                      │────stat(remotePath)────────────────────▶│           │
 │                      │                        │                 │──stat()──▶│
 │                      │                        │                 │◀──────────│
 │                      │◀───{mtime, size}───────────────────────│           │
 │                      │                        │                 │           │
 │                      │────download()──────────────────────────▶│           │
 │                      │                        │                 │──get()───▶│
 │                      │                        │                 │◀──────────│
 │                      │◀──────────────────────────────────────────────────│
 │                      │                        │                 │           │
 │                      │─store(localPath, metadata)─────▶│       │           │
 │                      │                        │─save()─▶│       │           │
 │◀──File Downloaded────│                        │         │       │           │
```

## Data Flow: File Upload with Modification Detection

```
User                Extension            FileMetadataTracker    SftpClient    Server
 │                      │                        │                 │           │
 │─Upload Command──────▶│                        │                 │           │
 │                      │                        │                 │           │
 │                      │──get(localPath)───────▶│                 │           │
 │                      │◀──metadata─────────────│                 │           │
 │                      │                        │                 │           │
 │                      │────connect()──────────────────────────▶│           │
 │                      │                        │                 │───SSH───▶│
 │                      │                        │                 │◀──────────│
 │                      │◀──────────────────────────────────────────────────│
 │                      │                        │                 │           │
 │                      │────stat(remotePath)────────────────────▶│           │
 │                      │                        │                 │──stat()──▶│
 │                      │                        │                 │◀──current─│
 │                      │◀───currentStats────────────────────────│   stats    │
 │                      │                        │                 │           │
 │──[Compare metadata]──│                        │                 │           │
 │                      │                        │                 │           │
 │  IF MODIFIED:        │                        │                 │           │
 │◀──⚠️ Warning Dialog──│                        │                 │           │
 │                      │                        │                 │           │
 │─[Overwrite/Cancel]──▶│                        │                 │           │
 │                      │                        │                 │           │
 │  IF Overwrite:       │                        │                 │           │
 │                      │────upload()────────────────────────────▶│           │
 │                      │                        │                 │──put()───▶│
 │                      │                        │                 │◀──────────│
 │                      │◀──────────────────────────────────────────────────│
 │                      │                        │                 │           │
 │                      │─store(new metadata)────▶│                │           │
 │◀──Upload Complete────│                        │                 │           │
```

## Modification Detection Algorithm

```typescript
// Step 1: Get stored metadata
const metadata = await fileTracker.getFileMetadata(localPath);

// Step 2: Get current server stats
const currentStats = await sftpClient.stat(remotePath);

// Step 3: Compare
if (currentStats.modifyTime !== metadata.mtime || 
    currentStats.size !== metadata.size) {
    
    // Step 4: Show warning
    const choice = await vscode.window.showWarningMessage(
        `⚠️ Warning: File modified on server!
        
        Original: ${new Date(metadata.mtime).toLocaleString()} (${metadata.size} bytes)
        Current:  ${new Date(currentStats.modifyTime).toLocaleString()} (${currentStats.size} bytes)
        
        Overwrite?`,
        'Overwrite',
        'Cancel'
    );
    
    // Step 5: Handle user choice
    if (choice !== 'Overwrite') {
        return; // Abort upload
    }
}

// Step 6: Proceed with upload
await sftpClient.uploadFile(localPath, remotePath);

// Step 7: Update metadata
await fileTracker.storeFileMetadata(localPath, {
    remotePath,
    mtime: currentStats.modifyTime,
    size: currentStats.size
});
```

## Storage Structure

### VSCode Workspace State
```json
{
  "ctlimsftp.fileMetadata": {
    "/home/user/project/config.json": {
      "remotePath": "/var/www/config.json",
      "mtime": 1705311600000,
      "size": 1024
    },
    "/home/user/project/index.js": {
      "remotePath": "/var/www/index.js",
      "mtime": 1705312800000,
      "size": 2048
    }
  }
}
```

### VSCode Configuration (settings.json)
```json
{
  "ctlimsftp.enableModificationWarning": true,
  "ctlimsftp.host": "sftp.example.com",
  "ctlimsftp.port": 22,
  "ctlimsftp.username": "developer",
  "ctlimsftp.remotePath": "/var/www"
}
```

## Security Architecture

```
┌────────────────────────────────────────────────────────┐
│                    Security Layers                      │
├────────────────────────────────────────────────────────┤
│                                                          │
│  1. Password Input: Not stored, only in memory         │
│     ┌──────────────────────────────────────┐          │
│     │  showInputBox({ password: true })    │          │
│     └──────────────────────────────────────┘          │
│                                                          │
│  2. SSH2 Connection: Encrypted transport               │
│     ┌──────────────────────────────────────┐          │
│     │  SSH2 Protocol (Port 22)             │          │
│     │  - Key exchange                      │          │
│     │  - Encryption: AES/ChaCha20          │          │
│     │  - Authentication                    │          │
│     └──────────────────────────────────────┘          │
│                                                          │
│  3. Metadata Storage: No sensitive data                │
│     ┌──────────────────────────────────────┐          │
│     │  Only stores:                        │          │
│     │  - File paths                        │          │
│     │  - Timestamps                        │          │
│     │  - File sizes                        │          │
│     │  (No file contents or passwords)     │          │
│     └──────────────────────────────────────┘          │
│                                                          │
│  4. CodeQL Security Scan: 0 vulnerabilities           │
│     ✅ No SQL injection                               │
│     ✅ No XSS vulnerabilities                         │
│     ✅ No command injection                           │
│     ✅ No path traversal                              │
│                                                          │
└────────────────────────────────────────────────────────┘
```

## Extension Lifecycle

```
VSCode Start
     │
     ▼
┌─────────────────────┐
│  Extension Loaded   │
│  (not yet active)   │
└─────────────────────┘
     │
     ▼ User triggers command
┌─────────────────────┐
│  activate()         │
│  - Register cmds    │
│  - Init services    │
└─────────────────────┘
     │
     ▼ Extension active
┌─────────────────────┐
│  Ready for use      │
│  - Commands work    │
│  - Listeners active │
└─────────────────────┘
     │
     ▼ VSCode closes
┌─────────────────────┐
│  deactivate()       │
│  - Disconnect SFTP  │
│  - Cleanup          │
└─────────────────────┘
```

## Key Design Decisions

### 1. Why Store Metadata Instead of File Hash?
- **Performance**: Computing hash for large files is slow
- **Simplicity**: mtime + size comparison is sufficient for most cases
- **Server compatibility**: All SFTP servers provide mtime and size
- **Low overhead**: Minimal storage requirement

### 2. Why Check on Upload, Not on Save?
- **User experience**: Save should be instant, not blocked by network I/O
- **Password requirement**: Would need password on every save
- **Network overhead**: Would make every save operation slow
- **Decision**: Only check when explicitly uploading

### 3. Why Not Store Password?
- **Security**: Storing passwords is risky
- **Best practice**: SSH keys are preferred for automation
- **Future**: SSH key support planned for v2.0

### 4. Why Use Workspace State, Not Global State?
- **Workspace-specific**: Different projects have different SFTP servers
- **Isolation**: Metadata doesn't leak between workspaces
- **Cleanup**: Automatically cleaned when workspace is deleted

## Code Statistics

- **Total TypeScript lines**: 426
- **Main logic (extension.ts)**: 280 lines
- **Metadata tracker**: 60 lines
- **SFTP client**: 70 lines
- **Type definitions**: 16 lines

## Dependencies

```json
{
  "runtime": {
    "ssh2-sftp-client": "^12.0.1",
    "ssh2": "^1.17.0"
  },
  "development": {
    "@types/vscode": "^1.107.0",
    "@types/node": "^25.0.2",
    "@types/ssh2": "^1.15.5",
    "typescript": "^5.9.3",
    "@vscode/vsce": "^3.7.1"
  }
}
```

## Performance Characteristics

| Operation | Time Complexity | Network Calls |
|-----------|----------------|---------------|
| Download file | O(n) | 2 (stat + get) |
| Upload file | O(n) | 3 (stat + put + stat) |
| Check modification | O(1) | 1 (stat) |
| Store metadata | O(1) | 0 |
| Get metadata | O(1) | 0 |

Where n = file size

## Future Enhancements

1. **SSH Key Authentication**: Avoid password prompts
2. **Batch Operations**: Download/upload multiple files
3. **Auto-sync**: Watch local changes and sync automatically
4. **Conflict Resolution**: Three-way merge UI
5. **File Browser**: Tree view of remote files
6. **Profile Management**: Multiple SFTP server profiles
7. **Diff View**: Show differences before overwrite
