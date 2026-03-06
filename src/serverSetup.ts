import * as crypto from 'crypto';
import Log from './common/logger';
import { getVSCodeServerConfig } from './serverConfig';
import SSHConnection from './ssh/sshConnection';

export interface ServerInstallOptions {
    id: string;
    quality: string;
    commit: string;
    version: string;      // upstream VS Code version (e.g. 1.105.1)
    buildVersion?: string; // VSCodium build version (e.g. 1.105.17075)
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
}

export interface ServerInstallResult {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: any;
}

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

// Modified to point to your AIX server by default
// const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.ibm.com/tony-varghese/vscodium-aix-server/releases/download/v${version}/vscodium-reh-aix-ppc64-${version}.tar.gz';

// Default AIX server download (tag == version, asset == vscodium-reh-aix-ppc64-${version}.tar.gz)
const DEFAULT_DOWNLOAD_URL_TEMPLATE =
    'https://github.com/tonykuttai/vscodium-aix-server/releases/download/${buildVersion}/vscodium-reh-aix-ppc64-${buildVersion}.tar.gz';


export async function installCodeServer(conn: SSHConnection, serverDownloadUrlTemplate: string | undefined, extensionIds: string[], envVariables: string[], platform: string | undefined, useSocketPath: boolean, logger: Log): Promise<ServerInstallResult> {
    let shell = 'powershell';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const result = await conn.exec('uname -s');

        if (result.stdout) {
            if (result.stdout.includes('windows32')) {
                platform = 'windows';
            } else if (result.stdout.includes('MINGW64')) {
                platform = 'windows';
                shell = 'bash';
            }
        } else if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
            }

            if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            }
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();
    let buildVersion = extractBuildVersionFromTemplate(
        vscodeServerConfig.serverDownloadUrlTemplate,
        vscodeServerConfig.version
    );

    // If platform is AIX, try to match client version
    if (platform === 'aix' || !platform) {
        logger.trace(`serverDownloadUrlTemplate: ${vscodeServerConfig.serverDownloadUrlTemplate}`);
        logger.trace(`vscodeServerConfig.version: ${vscodeServerConfig.version}`);
        
        // Extract build version from the client's download URL template
        const clientBuildVersion = extractBuildVersionFromTemplate(
            vscodeServerConfig.serverDownloadUrlTemplate,
            vscodeServerConfig.version
        );
        logger.trace(`Extracted clientBuildVersion: ${clientBuildVersion}`);

        if (clientBuildVersion && clientBuildVersion !== vscodeServerConfig.version) {
            // We successfully extracted a build version different from the base version
            buildVersion = clientBuildVersion;
            logger.trace(`Using client's VSCodium build version for AIX: ${buildVersion}`);
        } else {
            // Try to find a matching AIX server version based on client version
            const baseVersion = vscodeServerConfig.version.split('+')[0]; // Extract "1.105.1" from "1.105.1+bob1.0.0"
            logger.trace(`Attempting to find matching AIX version for base version: ${baseVersion}`);
            
            const matchingAIXVersion = await getMatchingAIXServerVersion(baseVersion);
            if (matchingAIXVersion) {
                logger.trace(`Using matching AIX server version for ${baseVersion}: ${matchingAIXVersion}`);
                buildVersion = matchingAIXVersion;
            } else {
                logger.trace(`No matching AIX version found for ${baseVersion}, using fallback`);
                // Last resort: try to use a known working version or client version
                // For Bob IDE 1.105.1+bob1.0.0, we know 1.105.17075 exists
                if (baseVersion === '1.105.1') {
                    buildVersion = '1.105.17075';
                    logger.trace(`Using hardcoded fallback version: ${buildVersion}`);
                } else {
                    buildVersion = vscodeServerConfig.version;
                    logger.trace(`Using client version as fallback: ${buildVersion}`);
                }
            }
        }
    }

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: vscodeServerConfig.version,          // 1.105.1
        buildVersion,                                 // 1.105.17075 (parsed)
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: vscodeServerConfig.release,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate:
            serverDownloadUrlTemplate ||
            vscodeServerConfig.serverDownloadUrlTemplate ||
            DEFAULT_DOWNLOAD_URL_TEMPLATE,
    };

    let commandOutput: { stdout: string; stderr: string };
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);
        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        let command = '';
        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions);

        logger.trace('Server install command:', installServerScript);
        // Fish shell does not support heredoc so let's workaround it using -c option,
        // also replace single quotes (') within the script with ('\'') as there's no quoting within single quotes, see https://unix.stackexchange.com/a/24676
        commandOutput = await conn.exec(`bash -c '${installServerScript.replace(/'/g, `'\\''`)}'`);
    }

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

// Simplified AIX installation - uses pre-built server directly
function generateBashInstallScript({
    id,
    quality,
    version,
    buildVersion,
    commit,
    release,
    extensionIds,
    envVariables,
    useSocketPath,
    serverApplicationName,
    serverDataFolderName,
    serverDownloadUrlTemplate
}: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    const effectiveBuildVersion = buildVersion ?? version;

    return `
# Server installation script

TMP_DIR="\${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_VERSION="${version}"
DISTRO_BUILD_VERSION="${effectiveBuildVersion}"
DISTRO_COMMIT="${commit}"
DISTRO_QUALITY="${quality}"
DISTRO_VSCODIUM_RELEASE="${release || ''}"

SERVER_APP_NAME="${serverApplicationName}"
SERVER_INITIAL_EXTENSIONS="${extensions}"
SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
SERVER_DATA_DIR="$HOME/${serverDataFolderName}"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
    echo "${id}: start"
    echo "exitCode==$1=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "logFile==$SERVER_LOGFILE=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `echo "${envVar}==$${envVar}=="`).join('\n')}
    echo "${id}: end"
    exit 0
}

# Check if platform is supported
KERNEL="$(uname -s)"
case $KERNEL in
    Darwin)
        PLATFORM="darwin"
        ;;
    Linux)
        PLATFORM="linux"
        ;;
    FreeBSD)
        PLATFORM="freebsd"
        ;;
    DragonFly)
        PLATFORM="dragonfly"
        ;;
    AIX)
        PLATFORM="aix"
        ;;
    *)
        echo "Error platform not supported: $KERNEL"
        print_install_results_and_exit 1
        ;;
esac

# Check machine architecture
ARCH="$(uname -m)"
case $ARCH in
    x86_64 | amd64)
        SERVER_ARCH="x64"
        ;;
    armv7l | armv8l)
        SERVER_ARCH="armhf"
        ;;
    arm64 | aarch64)
        SERVER_ARCH="arm64"
        ;;
    ppc64le)
        SERVER_ARCH="ppc64le"
        ;;
    ppc64|powerpc64)
        SERVER_ARCH="ppc64"
        ;;
    riscv64)
        SERVER_ARCH="riscv64"
        ;;
    loongarch64)
        SERVER_ARCH="loong64"
        ;;
    s390x)
        SERVER_ARCH="s390x"
        ;;
    *)
        # Handle AIX special case where uname -m returns machine ID
        if [[ $PLATFORM == "aix" ]]; then
            AIX_ARCH="$(uname -p 2>/dev/null)"
            case $AIX_ARCH in
                powerpc)
                    SERVER_ARCH="ppc64"
                    ARCH="ppc64"
                    ;;
                *)
                    echo "Error AIX architecture not supported: $AIX_ARCH"
                    print_install_results_and_exit 1
                    ;;
            esac
        else
            echo "Error architecture not supported: $ARCH"
            print_install_results_and_exit 1
        fi
        ;;
esac

# Add freeware path for AIX
if [[ $PLATFORM == "aix" ]]; then
    export PATH="/opt/freeware/bin:$PATH"
fi

# Handle OS release detection
if [[ $PLATFORM == "aix" ]]; then
    OS_RELEASE_ID="aix"
else
    # Use AIX-compatible sed syntax (no -i flag, use case-insensitive grep)
    OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//I' | sed 's/"//g')"
    if [[ -z $OS_RELEASE_ID ]]; then
        OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//I' | sed 's/"//g')"
        if [[ -z $OS_RELEASE_ID ]]; then
            OS_RELEASE_ID="unknown"
        fi
    fi
fi

# Create installation folder
if [[ ! -d $SERVER_DIR ]]; then
    mkdir -p $SERVER_DIR
    if (( $? > 0 )); then
        echo "Error creating server install directory"
        print_install_results_and_exit 1
    fi
fi

# adjust platform for vscodium download, if needed
if [[ $OS_RELEASE_ID = alpine ]]; then
    PLATFORM=$OS_RELEASE_ID
fi

# Build server download URL
if [[ $PLATFORM == "aix" ]]; then
    # For AIX, use the VSCodium build version (e.g. 1.105.17075), not the upstream VS Code version (1.105.1)
    SERVER_DOWNLOAD_URL="https://github.com/tonykuttai/vscodium-aix-server/releases/download/$DISTRO_BUILD_VERSION/vscodium-reh-aix-ppc64-$DISTRO_BUILD_VERSION.tar.gz"

    echo "Downloading VSCodium server for AIX from GitHub..."
    echo "URL: $SERVER_DOWNLOAD_URL"
else
    # Original VSCodium/VSCODE URL for other platforms
    SERVER_DOWNLOAD_URL="$(echo "${serverDownloadUrlTemplate.replace(/\$\{/g, '\\${')}" \
        | sed "s/\\\${quality}/$DISTRO_QUALITY/g" \
        | sed "s/\\\${version}/$DISTRO_VERSION/g" \
        | sed "s/\\\${commit}/$DISTRO_COMMIT/g" \
        | sed "s/\\\${os}/$PLATFORM/g" \
        | sed "s/\\\${arch}/$SERVER_ARCH/g" \
        | sed "s/\\\${release}/$DISTRO_VSCODIUM_RELEASE/g")"
fi

# Check if server script is already installed
if [[ ! -f $SERVER_SCRIPT ]]; then
    case "$PLATFORM" in
        darwin | linux | alpine | aix )
            ;;
        *)
            echo "Error '$PLATFORM' needs manual installation of remote extension host"
            print_install_results_and_exit 1
            ;;
    esac

    pushd $SERVER_DIR > /dev/null || {
        echo "Error: Failed to enter server directory $SERVER_DIR"
        print_install_results_and_exit 1
    }

    # Standard download logic for all platforms including AIX
    if [[ ! -z $(which wget) ]]; then
        wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz $SERVER_DOWNLOAD_URL
    elif [[ ! -z $(which curl) ]]; then
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz $SERVER_DOWNLOAD_URL
    else
        echo "Error no tool to download server binary"
        print_install_results_and_exit 1
    fi

    if (( $? > 0 )); then
        echo "Error downloading server from $SERVER_DOWNLOAD_URL"
        print_install_results_and_exit 1
    fi

    echo "Extracting server package..."
    # AIX tar doesn't support -z flag, use gunzip first
    if ! gunzip -c vscode-server.tar.gz | tar -xf - --strip-components 1; then
        echo "Error while extracting server contents"
        print_install_results_and_exit 1
    fi

    if (( $? > 0 )); then
        echo "Error while extracting server contents"
        print_install_results_and_exit 1
    fi

    # Special handling for AIX server wrapper
    if [[ $PLATFORM == "aix" ]]; then
        # Ensure the AIX server wrapper is executable
        if [[ -f "$SERVER_DIR/bin/codium-server" ]]; then
            chmod +x "$SERVER_DIR/bin/codium-server"
            echo "AIX server wrapper made executable"
        fi
        
        # Ensure Node.js is available for AIX
        echo "=== Setting up Node.js for AIX ==="
        
        NODE_BINARY=""
        
        # First, check if Node.js is already installed in home directory
        if [[ -x "$HOME/.nodejs-v22.22.0/bin/node" ]]; then
            NODE_BINARY="$HOME/.nodejs-v22.22.0/bin/node"
            echo "Found Node.js in home directory: $NODE_BINARY"
            $NODE_BINARY --version
        else
            # Try to find existing Node.js in system (skip wrapper scripts)
            echo "Searching for existing Node.js installation..."
            
            # Check common paths
            for node_path in /usr/bin/node /opt/freeware/bin/node /usr/local/bin/node; do
                if [[ -x "$node_path" ]]; then
                    # Verify it's not a wrapper script by checking if it references /opt/nodejs
                    if ! grep -q "/opt/nodejs/bin/node" "$node_path" 2>/dev/null; then
                        # Try to run it to verify it works
                        if "$node_path" --version >/dev/null 2>&1; then
                            NODE_BINARY="$node_path"
                            echo "Found working Node.js at: $NODE_BINARY"
                            $NODE_BINARY --version
                            break
                        fi
                    fi
                fi
            done
        fi
        
        # If no existing Node.js found, download and install
        if [[ -z "$NODE_BINARY" ]]; then
            echo "No existing Node.js found, downloading Node.js v22.22.0 for AIX..."
            
            NODE_INSTALL_DIR="$HOME/.nodejs-v22.22.0"
            NODE_BINARY="$NODE_INSTALL_DIR/bin/node"
            
            NODE_VERSION="v22.22.0"
            NODE_TARBALL="node-$NODE_VERSION-aix-ppc64.tar.gz"
            NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL"
            
            cd "$HOME"
            
            if [[ ! -z $(which wget) ]]; then
                wget --tries=3 --timeout=30 --no-verbose -O "$NODE_TARBALL" "$NODE_URL"
            elif [[ ! -z $(which curl) ]]; then
                curl --retry 3 --connect-timeout 30 --location --show-error --silent --output "$NODE_TARBALL" "$NODE_URL"
            else
                echo "Error: No download tool (wget/curl) available"
                print_install_results_and_exit 1
            fi
            
            if [[ -f "$NODE_TARBALL" ]]; then
                echo "Extracting Node.js to $NODE_INSTALL_DIR..."
                mkdir -p "$NODE_INSTALL_DIR"
                # AIX tar doesn't support -z flag, use gunzip first
                gunzip -c "$NODE_TARBALL" | tar -xf - -C "$NODE_INSTALL_DIR" --strip-components=1
                rm -f "$NODE_TARBALL"
                
                if [[ -x "$NODE_BINARY" ]]; then
                    echo "✓ Node.js installed successfully"
                    $NODE_BINARY --version
                else
                    echo "Error: Failed to extract Node.js properly"
                    print_install_results_and_exit 1
                fi
            else
                echo "Error: Failed to download Node.js"
                print_install_results_and_exit 1
            fi
            
            cd "$SERVER_DIR"
        fi
        
        # Try to create symlink at /opt/nodejs/bin/node (required by AIX server wrapper)
        SYMLINK_CREATED=false
        if mkdir -p /opt/nodejs/bin 2>/dev/null && ln -sf "$NODE_BINARY" /opt/nodejs/bin/node 2>/dev/null; then
            # Verify the symlink is actually usable (not just created)
            if /opt/nodejs/bin/node --version >/dev/null 2>&1; then
                SYMLINK_CREATED=true
                echo "✓ Created symlink: /opt/nodejs/bin/node -> $NODE_BINARY"
            else
                echo "⚠ Symlink created but not usable (permission issue)"
            fi
        fi
        
        # If symlink creation failed or not usable, patch the server wrapper
        if [[ "$SYMLINK_CREATED" != "true" ]]; then
            echo "⚠ Cannot use /opt/nodejs/bin/node (no permissions or not root)"
            echo "⚠ Patching server wrapper to use $NODE_BINARY directly..."
            
            # Patch codium-server wrapper to use home directory Node.js
            if [[ -f "$SERVER_DIR/bin/codium-server" ]]; then
                cp "$SERVER_DIR/bin/codium-server" "$SERVER_DIR/bin/codium-server.backup"
                
                # Replace the NODE_BIN search logic with direct path
                # Use a temp file to avoid variable expansion issues
                TEMP_WRAPPER="$SERVER_DIR/bin/codium-server.new"
                cat > "$TEMP_WRAPPER" << 'WRAPPER_EOF'
#!/bin/bash

# Patched to use Node.js from home directory
NODE_BIN="NODE_BINARY_PLACEHOLDER"

if [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: Node.js not found at $NODE_BIN" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_ROOT="$(dirname "$SCRIPT_DIR")"

# Add node-pty native-libs to LIBPATH with absolute path
export LIBPATH="\${SERVER_ROOT}/node_modules/node-pty/lib/native-libs:\${LIBPATH}"

# Find the server main script (support both locations)
SERVER_MAIN=""
if [[ -f "$SERVER_ROOT/out/server-main.js" ]]; then
    SERVER_MAIN="$SERVER_ROOT/out/server-main.js"
elif [[ -f "$SERVER_ROOT/out/vs/server/main.js" ]]; then
    SERVER_MAIN="$SERVER_ROOT/out/vs/server/main.js"
else
    echo "ERROR: Server main script not found" >&2
    exit 1
fi

# Check if AIX platform override exists
AIX_OVERRIDE=""
if [[ -f "$SERVER_ROOT/aix-platform-override.js" ]]; then
    AIX_OVERRIDE="-r $SERVER_ROOT/aix-platform-override.js"
fi

# Execute the server with AIX platform override if available
exec "$NODE_BIN" $AIX_OVERRIDE "$SERVER_MAIN" "$@"
WRAPPER_EOF
                # Replace placeholder with actual Node.js path
                sed "s|NODE_BINARY_PLACEHOLDER|$NODE_BINARY|g" "$TEMP_WRAPPER" > "$SERVER_DIR/bin/codium-server"
                rm -f "$TEMP_WRAPPER"
                chmod +x "$SERVER_DIR/bin/codium-server"
                echo "✓ Patched codium-server to use $NODE_BINARY"
            fi
            
            # Also patch the node wrapper if it exists
            if [[ -f "$SERVER_DIR/bin/node" ]]; then
                cat > "$SERVER_DIR/bin/node" <<EOF
#!/usr/bin/env sh
exec "$NODE_BINARY" "\$@"
EOF
                chmod +x "$SERVER_DIR/bin/node"
                echo "✓ Patched $SERVER_DIR/bin/node wrapper"
            fi
            
            # Comprehensive patching: Replace all hardcoded /opt/nodejs references
            # Get Node.js directory
            NODE_DIR="\$(dirname "\$NODE_BINARY")"
            NODE_PRE_DIR="\$(dirname "\$NODE_DIR")"
            
            echo "=== Patching Server Files ==="
            echo "Replacing: /opt/nodejs"
            echo "With: \$NODE_PRE_DIR"
            
            # Count files to patch
            FILE_COUNT=\$(find "\$SERVER_DIR" -type f \\( -name "*.sh" -o -name "*.js" -o -name "*.json" -o -name "*-server" \\) -exec grep -l "/opt/nodejs" {} \\; 2>/dev/null | wc -l)
            echo "Found \$FILE_COUNT files to patch"
            
            if [[ \$FILE_COUNT -gt 0 ]]; then
                find "\$SERVER_DIR" -type f \\( -name "*.sh" -o -name "*.js" -o -name "*.json" -o -name "*-server" \\) -exec grep -l "/opt/nodejs" {} \\; 2>/dev/null | while read -r file; do
                    echo "  Patching: \\\${file#\$SERVER_DIR/}"
                    sed -i.bak "s|/opt/nodejs|\$NODE_PRE_DIR|g" "\$file"
                    rm -f "\$file.bak"
                done
                echo "✓ Patched \$FILE_COUNT files"
            else
                echo "No files need patching"
            fi
        fi
        
        # Update PATH
        export PATH="$NODE_INSTALL_DIR/bin:$PATH"
        echo "✓ Node.js setup complete"
        
        # Detect if this is Bob IDE by checking version string or server application name
        IS_BOB_IDE=false
        if [[ "$DISTRO_VERSION" == *"+bob"* ]] || [[ "$SERVER_APP_NAME" == *"bob"* ]]; then
            IS_BOB_IDE=true
            echo "=== Detected Bob IDE ==="
        else
            echo "=== Detected VSCodium/VS Code ==="
        fi
        
        # Bob IDE specific operations
        if [[ "$IS_BOB_IDE" == true ]]; then
            echo "=== Applying Bob IDE Specific Configuration ==="
            
            # Patch product.json to match Bob IDE commit/version for client handshake
            if [[ -f "$SERVER_DIR/product.json" ]]; then
                echo "=== AIX VSCodium Server Version Update ==="
                echo "Patching product.json with Bob IDE values..."
                echo "Target Version: $DISTRO_VERSION"
                echo "Target Commit: $DISTRO_COMMIT"
                
                # Backup original product.json
                cp "$SERVER_DIR/product.json" "$SERVER_DIR/product.json.backup"
                
                # Use Python to safely update JSON (more reliable than sed for JSON)
                python3 -c "
import json
import sys

try:
    with open('$SERVER_DIR/product.json', 'r') as f:
        data = json.load(f)
    
    # Update top-level version and commit
    data['version'] = '$DISTRO_VERSION'
    data['commit'] = '$DISTRO_COMMIT'
    
    with open('$SERVER_DIR/product.json', 'w') as f:
        json.dump(data, f, indent=2)
    
    print('✓ product.json patched successfully using Python')
except Exception as e:
    print(f'Warning: Python patching failed: {e}')
    print('Falling back to sed...')
    sys.exit(1)
" || {
                    # Fallback to sed if Python fails
                    echo "Using sed fallback for product.json patching..."
                    sed '0,/"version"[[:space:]]*:[[:space:]]*"[^"]*"/{s/"version"[[:space:]]*:[[:space:]]*"[^"]*"/"version": "'$DISTRO_VERSION'"/;}' "$SERVER_DIR/product.json" > "$SERVER_DIR/product.json.tmp1"
                    sed '0,/"commit"[[:space:]]*:[[:space:]]*"[^"]*"/{s/"commit"[[:space:]]*:[[:space:]]*"[^"]*"/"commit": "'$DISTRO_COMMIT'"/;}' "$SERVER_DIR/product.json.tmp1" > "$SERVER_DIR/product.json.tmp2"
                    mv "$SERVER_DIR/product.json.tmp2" "$SERVER_DIR/product.json"
                    rm -f "$SERVER_DIR/product.json.tmp1"
                    echo "✓ product.json patched with sed"
                }
                
                echo "Verification (first 5 matches):"
                grep -E '(commit|version)' "$SERVER_DIR/product.json" | head -5
                echo "Backup saved: product.json.backup"
            else
                echo "Warning: product.json not found at $SERVER_DIR/product.json"
            fi
            
            # Update package.json if it exists
            if [[ -f "$SERVER_DIR/package.json" ]]; then
                echo "Updating package.json version..."
                cp "$SERVER_DIR/package.json" "$SERVER_DIR/package.json.backup"
                # AIX-compatible sed: create temp file, then replace
                sed '0,/"version"[[:space:]]*:[[:space:]]*"[^"]*"/{s/"version"[[:space:]]*:[[:space:]]*"[^"]*"/"version": "'$DISTRO_VERSION'"/;}' "$SERVER_DIR/package.json" > "$SERVER_DIR/package.json.tmp"
                mv "$SERVER_DIR/package.json.tmp" "$SERVER_DIR/package.json"
                echo "✓ package.json updated"
            fi
            
            # Skip JavaScript file patching - it's causing files to be emptied
            # The product.json patching is sufficient for the server to work
            echo "=== Skipping JavaScript File Patching ==="
            echo "Note: JavaScript files are not patched to avoid corruption"
            echo "The product.json patching is sufficient for server operation"
            
            # Create version marker files for reference
            echo "$DISTRO_VERSION" > "$SERVER_DIR/version"
            echo "$DISTRO_COMMIT" > "$SERVER_DIR/commit"
            echo "✓ Created version marker files"
            
            # Create symlink for bobide-server
            if [[ ! -f "$SERVER_SCRIPT" ]]; then
                ln -sf "$SERVER_DIR/bin/codium-server" "$SERVER_SCRIPT"
                echo "Created symlink: $SERVER_APP_NAME -> codium-server"
            fi
            
            echo "=== Bob IDE Specific Configuration Complete ==="
        else
            echo "=== VSCodium/VS Code Configuration ==="
            echo "Skipping Bob IDE specific patching operations"
            
            # For VSCodium, just ensure the server script exists or create standard symlink
            if [[ ! -f "$SERVER_SCRIPT" ]]; then
                # Check if codium-server exists and create symlink
                if [[ -f "$SERVER_DIR/bin/codium-server" ]]; then
                    ln -sf "$SERVER_DIR/bin/codium-server" "$SERVER_SCRIPT"
                    echo "Created symlink: $SERVER_APP_NAME -> codium-server"
                fi
            fi
            
            echo "✓ VSCodium configuration complete (no patching required)"
        fi
        
        echo "=== AIX Server Setup Complete ==="
        
        # Setup .bashrc for remote-cli
        BASHRC="$HOME/.bashrc"
        SNIPPET_MARKER="# === VSCodium remote-cli PATH setup ==="
        
        # Create .bashrc if it doesn't exist
        if [ ! -f "$BASHRC" ]; then
          touch "$BASHRC"
        fi
        
        # Add snippet only if it's not already present
        if ! grep -Fq "$SNIPPET_MARKER" "$BASHRC"; then
          cat >> "$BASHRC" <<'EOF'

# === VSCodium remote-cli PATH setup ===
# Add all matching remote-cli directories to PATH
if [ -d "$HOME/.vscodium-server/bin" ]; then
  for dir in "$HOME"/.vscodium-server/bin/*/bin/remote-cli; do
      if [ -d "$dir" ]; then
          PATH="$PATH:$dir"
      fi
  done
  export PATH
fi
# === End VSCodium remote-cli PATH setup ===

EOF
          echo "remote-cli PATH snippet added to $BASHRC"
        else
          echo "Snippet already present in $BASHRC, not adding again."
        fi
    fi

    if [[ ! -f $SERVER_SCRIPT ]]; then
        echo "Error server contents are corrupted"
        print_install_results_and_exit 1
    fi

    rm -f vscode-server.tar.gz

    popd > /dev/null
else
    echo "Server script already installed in $SERVER_SCRIPT"
fi

# Download and install Bob IDE extensions (only for Bob IDE on AIX)
if [[ $PLATFORM == "aix" ]] && [[ "$IS_BOB_IDE" == true ]]; then
    echo "=== Installing Bob IDE Extensions ==="
    BOB_EXTENSIONS_URL="https://api.us-east.bob.ibm.com/update/reh/ibm-bob/linux/x64/1.105.1+bob1.0.0"
    BOB_EXTENSIONS_DIR="$TMP_DIR/bob-extensions-$DISTRO_COMMIT"
    
    mkdir -p "$BOB_EXTENSIONS_DIR"
    cd "$BOB_EXTENSIONS_DIR"
    
    echo "Downloading Bob IDE extensions from $BOB_EXTENSIONS_URL..."
    if [[ ! -z $(which wget) ]]; then
        wget --tries=3 --timeout=10 --no-verbose -O bob-extensions.tar.gz "$BOB_EXTENSIONS_URL"
    elif [[ ! -z $(which curl) ]]; then
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output bob-extensions.tar.gz "$BOB_EXTENSIONS_URL"
    else
        echo "Warning: No download tool available, skipping Bob extensions"
    fi
    
    if [[ -f bob-extensions.tar.gz ]]; then
        echo "Extracting Bob IDE extensions..."
        # AIX tar doesn't support -z flag, use gunzip first
        gunzip -c bob-extensions.tar.gz | tar -xf -
        
        # Create extensions directory if it doesn't exist
        mkdir -p "$SERVER_DIR/extensions"
        
        # Copy bob-walkthroughs and bob-code extensions
        if [[ -d "extensions/bob-walkthroughs" ]]; then
            cp -r extensions/bob-walkthroughs "$SERVER_DIR/extensions/"
            echo "✓ Copied bob-walkthroughs extension"
        else
            echo "Warning: bob-walkthroughs extension not found"
        fi
        
        if [[ -d "extensions/bob-code" ]]; then
            cp -r extensions/bob-code "$SERVER_DIR/extensions/"
            echo "✓ Copied bob-code extension"
        else
            echo "Warning: bob-code extension not found"
        fi
        
        # Cleanup
        cd - > /dev/null
        rm -rf "$BOB_EXTENSIONS_DIR"
        echo "✓ Bob IDE extensions installed"
    else
        echo "Warning: Failed to download Bob IDE extensions"
    fi
    echo "=== Bob IDE Extensions Setup Complete ==="
else
    echo "=== Skipping Bob IDE Extensions (VSCodium/VS Code detected) ==="
fi

# Configure server settings for AIX compatibility
echo "=== Configuring Server Settings for AIX ==="
mkdir -p "$SERVER_DATA_DIR/data/Machine"
cat > "$SERVER_DATA_DIR/data/Machine/settings.json" << 'SETTINGS_EOF'
{
  "terminal.integrated.shell.linux": "/opt/freeware/bin/bash",
  "terminal.integrated.defaultProfile.linux": "bash",
  "terminal.integrated.profiles.linux": {
    "bash": {
      "path": "/opt/freeware/bin/bash"
    }
  }
}
SETTINGS_EOF
echo "✓ Server settings configured (using bash instead of ksh)"

# Try to find if server is already running
if [[ -f $SERVER_PIDFILE ]]; then
    SERVER_PID="$(cat $SERVER_PIDFILE)"
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -p $SERVER_PID | grep $SERVER_SCRIPT)"
else
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -A | grep $SERVER_SCRIPT | grep -v grep)"
fi

if [[ -z $SERVER_RUNNING_PROCESS ]]; then
    if [[ -f $SERVER_LOGFILE ]]; then
        rm $SERVER_LOGFILE
    fi
    if [[ -f $SERVER_TOKENFILE ]]; then
        rm $SERVER_TOKENFILE
    fi

    touch $SERVER_TOKENFILE
    chmod 600 $SERVER_TOKENFILE
    SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE

    $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
    echo $! > $SERVER_PIDFILE
else
    echo "Server script is already running $SERVER_SCRIPT"
fi

if [[ -f $SERVER_TOKENFILE ]]; then
    SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
    echo "Error server token file not found $SERVER_TOKENFILE"
    print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
    for i in {1..5}; do
        LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
        if [[ -n $LISTENING_ON ]]; then
            break
        fi
        sleep 1
    done

    if [[ -z $LISTENING_ON ]]; then
        echo "Error server did not start successfully"
        print_install_results_and_exit 1
    fi
else
    echo "Error server log file not found $SERVER_LOGFILE"
    print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
`;
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate }: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');

    return `
# Server installation script

$TMP_DIR="$env:TEMP\\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_VERSION="${version}"
$DISTRO_COMMIT="${commit}"
$DISTRO_QUALITY="${quality}"
$DISTRO_VSCODIUM_RELEASE="${release ?? ''}"

$SERVER_APP_NAME="${serverApplicationName}"
$SERVER_INITIAL_EXTENSIONS="${extensions}"
$SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
$SERVER_DATA_DIR="$(Resolve-Path ~)\\${serverDataFolderName}"
$SERVER_DIR="$SERVER_DATA_DIR\\bin\\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\\bin\\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.token"
$SERVER_ARCH=
$SERVER_CONNECTION_TOKEN=
$SERVER_DOWNLOAD_URL=

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"

function printInstallResults($code) {
    "${id}: start"
    "exitCode==$code=="
    "listeningOn==$LISTENING_ON=="
    "connectionToken==$SERVER_CONNECTION_TOKEN=="
    "logFile==$SERVER_LOGFILE=="
    "osReleaseId==$OS_RELEASE_ID=="
    "arch==$ARCH=="
    "platform==$PLATFORM=="
    "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `"${envVar}==$${envVar}=="`).join('\n')}
    "${id}: end"
}

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE
# Use x64 version for ARM64, as it's not yet available.
if(($ARCH -eq "AMD64") -or ($ARCH -eq "IA64") -or ($ARCH -eq "ARM64")) {
    $SERVER_ARCH="x64"
}
else {
    "Error architecture not supported: $ARCH"
    printInstallResults 1
    exit 0
}

# Create installation folder
if(!(Test-Path $SERVER_DIR)) {
    try {
        ni -it d $SERVER_DIR -f -ea si
    } catch {
        "Error creating server install directory - $($_.ToString())"
        exit 1
    }

    if(!(Test-Path $SERVER_DIR)) {
        "Error creating server install directory"
        exit 1
    }
}

cd $SERVER_DIR

# Check if server script is already installed
if(!(Test-Path $SERVER_SCRIPT)) {
    del vscode-server.tar.gz

    $REQUEST_ARGUMENTS = @{
        Uri="${downloadUrl}"
        TimeoutSec=20
        OutFile="vscode-server.tar.gz"
        UseBasicParsing=$True
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    Invoke-RestMethod @REQUEST_ARGUMENTS

    if(Test-Path "vscode-server.tar.gz") {
        tar -xf vscode-server.tar.gz --strip-components 1

        del vscode-server.tar.gz
    }

    if(!(Test-Path $SERVER_SCRIPT)) {
        "Error while installing the server binary"
        exit 1
    }
}
else {
    "Server script already installed in $SERVER_SCRIPT"
}

# Try to find if server is already running
if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\\*") {
    echo "Server script is already running $SERVER_SCRIPT"
}
else {
    if(Test-Path $SERVER_LOGFILE) {
        del $SERVER_LOGFILE
    }
    if(Test-Path $SERVER_PIDFILE) {
        del $SERVER_PIDFILE
    }
    if(Test-Path $SERVER_TOKENFILE) {
        del $SERVER_TOKENFILE
    }

    $SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

    $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> '$SERVER_LOGFILE'"

    $START_ARGUMENTS = @{
        FilePath = "powershell.exe"
        WindowStyle = "hidden"
        ArgumentList = @(
            "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "$SERVER_SCRIPT $SCRIPT_ARGUMENTS"
        )
        PassThru = $True
    }

    $SERVER_ID = (start @START_ARGUMENTS).ID

    if($SERVER_ID) {
        [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
    }
}

if(Test-Path $SERVER_TOKENFILE) {
    $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
    "Error server token file not found $SERVER_TOKENFILE"
    printInstallResults 1
    exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
    Path = $SERVER_LOGFILE
    Pattern = "Extension host agent listening on (\\d+)"
}

for($I = 1; $I -le 5; $I++) {
    if(Test-Path $SERVER_LOGFILE) {
        $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

        if($GROUPS) {
            $LISTENING_ON = $GROUPS[1].Value
            break
        }
    }

    sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
    "Error server log file not found $SERVER_LOGFILE"
    printInstallResults 1
    exit 0
}

# Finish server setup
printInstallResults 0

if($SERVER_ID) {
    while($True) {
        if(!(gps -Id $SERVER_ID)) {
            "server died, exit"
            exit 0
        }

        sleep 30
    }
}
`;
}

function extractBuildVersionFromTemplate(
    template: string | undefined,
    fallback: string
): string {
    if (!template) {
        return fallback;
    }

    // Example template:
    // https://github.com/VSCodium/vscodium/releases/download/1.105.17075/vscodium-reh-${os}-${arch}-1.105.17075.tar.gz
    const m = template.match(/download\/([^/]+)\//);
    return m?.[1] ?? fallback;
}

async function getMatchingAIXServerVersion(baseVersion: string): Promise<string | null> {
    try {
        // Fetch all releases
        const response = await fetch('https://api.github.com/repos/tonykuttai/vscodium-aix-server/releases');
        if (!response.ok) return null;

        const releases = await response.json();
        
        // Extract major.minor from baseVersion (e.g., "1.105" from "1.105.1")
        const versionParts = baseVersion.split('.');
        const majorMinor = `${versionParts[0]}.${versionParts[1]}`;
        
        // Find releases that match the major.minor version
        const matchingReleases = releases
            .filter((release: any) => release.tag_name.startsWith(majorMinor))
            .map((release: any) => release.tag_name)
            .sort((a: string, b: string) => {
                // Sort by build number (last part) descending
                const aBuild = parseInt(a.split('.').pop() || '0');
                const bBuild = parseInt(b.split('.').pop() || '0');
                return bBuild - aBuild;
            });
        
        // Return the latest matching version
        return matchingReleases.length > 0 ? matchingReleases[0] : null;
    } catch (error) {
        return null;
    }
}
