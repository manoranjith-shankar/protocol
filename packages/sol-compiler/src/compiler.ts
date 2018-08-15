import { assert } from '@0xproject/assert';
import {
    FallthroughResolver,
    FSResolver,
    NameResolver,
    NPMResolver,
    RelativeFSResolver,
    Resolver,
    URLResolver,
} from '@0xproject/sol-resolver';
import { fetchAsync, logUtils } from '@0xproject/utils';
import chalk from 'chalk';
import * as ethUtil from 'ethereumjs-util';
import * as fs from 'fs';
import * as _ from 'lodash';
import * as path from 'path';
import * as requireFromString from 'require-from-string';
import * as semver from 'semver';
import solc = require('solc');

import { compilerOptionsSchema } from './schemas/compiler_options_schema';
import { binPaths } from './solc/bin_paths';
import {
    createDirIfDoesNotExistAsync,
    getContractArtifactIfExistsAsync,
    getNormalizedErrMsg,
    parseDependencies,
    parseSolidityVersionRange,
} from './utils/compiler';
import { constants } from './utils/constants';
import { fsWrapper } from './utils/fs_wrapper';
import { CompilerOptions, ContractArtifact, ContractVersionData } from './utils/types';
import { utils } from './utils/utils';

type TYPE_ALL_FILES_IDENTIFIER = '*';
const ALL_CONTRACTS_IDENTIFIER = '*';
const ALL_FILES_IDENTIFIER = '*';
const SOLC_BIN_DIR = path.join(__dirname, '..', '..', 'solc_bin');
const DEFAULT_CONTRACTS_DIR = path.resolve('contracts');
const DEFAULT_ARTIFACTS_DIR = path.resolve('artifacts');
// Solc compiler settings cannot be configured from the commandline.
// If you need this configured, please create a `compiler.json` config file
// with your desired configurations.
const DEFAULT_COMPILER_SETTINGS: solc.CompilerSettings = {
    optimizer: {
        enabled: false,
    },
    outputSelection: {
        [ALL_FILES_IDENTIFIER]: {
            [ALL_CONTRACTS_IDENTIFIER]: ['abi', 'evm.bytecode.object'],
        },
    },
};
const CONFIG_FILE = 'compiler.json';

/**
 * The Compiler facilitates compiling Solidity smart contracts and saves the results
 * to artifact files.
 */
export class Compiler {
    private readonly _resolver: Resolver;
    private readonly _nameResolver: NameResolver;
    private readonly _contractsDir: string;
    private readonly _compilerSettings: solc.CompilerSettings;
    private readonly _artifactsDir: string;
    private readonly _solcVersionIfExists: string | undefined;
    private readonly _specifiedContracts: string[] | TYPE_ALL_FILES_IDENTIFIER;
    /**
     * Instantiates a new instance of the Compiler class.
     * @return An instance of the Compiler class.
     */
    constructor(opts?: CompilerOptions) {
        assert.doesConformToSchema('opts', opts, compilerOptionsSchema);
        // TODO: Look for config file in parent directories if not found in current directory
        const config: CompilerOptions = fs.existsSync(CONFIG_FILE)
            ? JSON.parse(fs.readFileSync(CONFIG_FILE).toString())
            : {};
        const passedOpts = opts || {};
        assert.doesConformToSchema('compiler.json', config, compilerOptionsSchema);
        this._contractsDir = passedOpts.contractsDir || config.contractsDir || DEFAULT_CONTRACTS_DIR;
        this._solcVersionIfExists = passedOpts.solcVersion || config.solcVersion;
        this._compilerSettings = passedOpts.compilerSettings || config.compilerSettings || DEFAULT_COMPILER_SETTINGS;
        this._artifactsDir = passedOpts.artifactsDir || config.artifactsDir || DEFAULT_ARTIFACTS_DIR;
        this._specifiedContracts = passedOpts.contracts || config.contracts || ALL_CONTRACTS_IDENTIFIER;
        this._nameResolver = new NameResolver(path.resolve(this._contractsDir));
        const resolver = new FallthroughResolver();
        resolver.appendResolver(new URLResolver());
        const packagePath = path.resolve('');
        resolver.appendResolver(new NPMResolver(packagePath));
        resolver.appendResolver(new RelativeFSResolver(this._contractsDir));
        resolver.appendResolver(new FSResolver());
        resolver.appendResolver(this._nameResolver);
        this._resolver = resolver;
    }
    /**
     * Compiles selected Solidity files found in `contractsDir` and writes JSON artifacts to `artifactsDir`.
     */
    public async compileAsync(): Promise<void> {
        await createDirIfDoesNotExistAsync(this._artifactsDir);
        await createDirIfDoesNotExistAsync(SOLC_BIN_DIR);
        let contractNamesToCompile: string[] = [];
        if (this._specifiedContracts === ALL_CONTRACTS_IDENTIFIER) {
            const allContracts = this._nameResolver.getAll();
            contractNamesToCompile = _.map(allContracts, contractSource =>
                path.basename(contractSource.path, constants.SOLIDITY_FILE_EXTENSION),
            );
        } else {
            contractNamesToCompile = this._specifiedContracts;
        }
        return this._compileContractsAsync(contractNamesToCompile);
    }
    /**
     * Compiles contract and saves artifact to artifactsDir.
     * @param fileName Name of contract with '.sol' extension.
     */
    private async _compileContractsAsync(contractNames: string[]): Promise<void> {
        const inputsByVersion: {
            [solcVersion: string]: {
                standardInput: solc.StandardInput;
                contractsToCompile: string[];
            };
        } = {};

        const contractData: {
            [contractPath: string]: {
                currentArtifactIfExists: ContractArtifact | void;
                sourceTreeHashHex: string;
                contractName: string;
            };
        } = {};

        for (const contractName of contractNames) {
            const contractSource = this._resolver.resolve(contractName);
            contractData[contractSource.path] = {
                contractName,
                currentArtifactIfExists: await getContractArtifactIfExistsAsync(this._artifactsDir, contractName),
                sourceTreeHashHex: `0x${this._getSourceTreeHash(
                    path.join(this._contractsDir, contractSource.path),
                ).toString('hex')}`,
            };
            let shouldCompile = false;
            if (_.isUndefined(contractData[contractSource.path].currentArtifactIfExists)) {
                shouldCompile = true;
            } else {
                const currentArtifact = contractData[contractSource.path].currentArtifactIfExists as ContractArtifact;
                const isUserOnLatestVersion = currentArtifact.schemaVersion === constants.LATEST_ARTIFACT_VERSION;
                const didCompilerSettingsChange = !_.isEqual(currentArtifact.compiler.settings, this._compilerSettings);
                const didSourceChange =
                    currentArtifact.sourceTreeHashHex !== contractData[contractSource.path].sourceTreeHashHex;
                shouldCompile = !isUserOnLatestVersion || didCompilerSettingsChange || didSourceChange;
            }
            if (!shouldCompile) {
                continue;
            }
            let solcVersion = this._solcVersionIfExists;
            if (_.isUndefined(solcVersion)) {
                const solcVersionRange = parseSolidityVersionRange(contractSource.source);
                const availableCompilerVersions = _.keys(binPaths);
                solcVersion = semver.maxSatisfying(availableCompilerVersions, solcVersionRange);
            }
            if (_.isUndefined(inputsByVersion[solcVersion])) {
                inputsByVersion[solcVersion] = {
                    standardInput: {
                        language: 'Solidity',
                        sources: {},
                        settings: this._compilerSettings,
                    },
                    contractsToCompile: [],
                };
            }
            inputsByVersion[solcVersion].standardInput.sources[contractSource.path] = {
                content: contractSource.source,
            };
            inputsByVersion[solcVersion].contractsToCompile.push(contractSource.path);
        }

        for (const solcVersion in inputsByVersion) {
            if (!inputsByVersion.hasOwnProperty(solcVersion)) {
                continue;
            }

            const input = inputsByVersion[solcVersion];
            logUtils.log(
                `Compiling ${input.contractsToCompile.length} contracts (${
                    input.contractsToCompile
                }) with Solidity v${solcVersion}...`,
            );

            const { solcInstance, fullSolcVersion } = await Compiler._getSolcAsync(solcVersion);

            const compiled = this._compile(solcInstance, input.standardInput);

            for (const contractPath of input.contractsToCompile) {
                await this._verifyAndPersistCompiledContractAsync(
                    contractPath,
                    contractData[contractPath],
                    fullSolcVersion,
                    compiled,
                );
            }
        }
    }
    private static async _getSolcAsync(
        solcVersion: string,
    ): Promise<{ solcInstance: solc.SolcInstance; fullSolcVersion: string }> {
        const fullSolcVersion = binPaths[solcVersion];
        const compilerBinFilename = path.join(SOLC_BIN_DIR, fullSolcVersion);
        let solcjs: string;
        const isCompilerAvailableLocally = fs.existsSync(compilerBinFilename);
        if (isCompilerAvailableLocally) {
            solcjs = fs.readFileSync(compilerBinFilename).toString();
        } else {
            logUtils.log(`Downloading ${fullSolcVersion}...`);
            const url = `${constants.BASE_COMPILER_URL}${fullSolcVersion}`;
            const response = await fetchAsync(url);
            const SUCCESS_STATUS = 200;
            if (response.status !== SUCCESS_STATUS) {
                throw new Error(`Failed to load ${fullSolcVersion}`);
            }
            solcjs = await response.text();
            fs.writeFileSync(compilerBinFilename, solcjs);
        }
        const solcInstance = solc.setupMethods(requireFromString(solcjs, compilerBinFilename));
        return { solcInstance, fullSolcVersion };
    }
    private async _verifyAndPersistCompiledContractAsync(
        contractPath: string,
        contractMetadata: {
            currentArtifactIfExists: ContractArtifact | void;
            sourceTreeHashHex: string;
            contractName: string;
        },
        fullSolcVersion: string,
        compiled: solc.StandardOutput,
    ): Promise<void> {
        const contractName = contractMetadata.contractName;
        const sourceTreeHashHex = contractMetadata.sourceTreeHashHex;
        const currentArtifactIfExists = contractMetadata.currentArtifactIfExists;

        const compiledData = compiled.contracts[contractPath][contractName];
        if (_.isUndefined(compiledData)) {
            throw new Error(
                `Contract ${contractName} not found in ${contractPath}. Please make sure your contract has the same name as it's file name`,
            );
        }
        if (!_.isUndefined(compiledData.evm)) {
            if (!_.isUndefined(compiledData.evm.bytecode) && !_.isUndefined(compiledData.evm.bytecode.object)) {
                compiledData.evm.bytecode.object = ethUtil.addHexPrefix(compiledData.evm.bytecode.object);
            }
            if (
                !_.isUndefined(compiledData.evm.deployedBytecode) &&
                !_.isUndefined(compiledData.evm.deployedBytecode.object)
            ) {
                compiledData.evm.deployedBytecode.object = ethUtil.addHexPrefix(
                    compiledData.evm.deployedBytecode.object,
                );
            }
        }

        const sourceCodes = _.mapValues(
            compiled.sources,
            (_1, sourceFilePath) => this._resolver.resolve(sourceFilePath).source,
        );
        const contractVersion: ContractVersionData = {
            compilerOutput: compiledData,
            sources: compiled.sources,
            sourceCodes,
            sourceTreeHashHex,
            compiler: {
                name: 'solc',
                version: fullSolcVersion,
                settings: this._compilerSettings,
            },
        };

        let newArtifact: ContractArtifact;
        if (!_.isUndefined(currentArtifactIfExists)) {
            const currentArtifact = currentArtifactIfExists as ContractArtifact;
            newArtifact = {
                ...currentArtifact,
                ...contractVersion,
            };
        } else {
            newArtifact = {
                schemaVersion: constants.LATEST_ARTIFACT_VERSION,
                contractName,
                ...contractVersion,
                networks: {},
            };
        }

        const artifactString = utils.stringifyWithFormatting(newArtifact);
        const currentArtifactPath = `${this._artifactsDir}/${contractName}.json`;
        await fsWrapper.writeFileAsync(currentArtifactPath, artifactString);
        logUtils.log(`${contractName} artifact saved!`);
    }
    private _compile(solcInstance: solc.SolcInstance, standardInput: solc.StandardInput): solc.StandardOutput {
        const compiled: solc.StandardOutput = JSON.parse(
            solcInstance.compileStandardWrapper(JSON.stringify(standardInput), importPath => {
                const sourceCodeIfExists = this._resolver.resolve(importPath);
                return { contents: sourceCodeIfExists.source };
            }),
        );
        if (!_.isUndefined(compiled.errors)) {
            const SOLIDITY_WARNING = 'warning';
            const errors = _.filter(compiled.errors, entry => entry.severity !== SOLIDITY_WARNING);
            const warnings = _.filter(compiled.errors, entry => entry.severity === SOLIDITY_WARNING);
            if (!_.isEmpty(errors)) {
                errors.forEach(error => {
                    const normalizedErrMsg = getNormalizedErrMsg(error.formattedMessage || error.message);
                    logUtils.log(chalk.red(normalizedErrMsg));
                });
                throw new Error('Compilation errors encountered');
            } else {
                warnings.forEach(warning => {
                    const normalizedWarningMsg = getNormalizedErrMsg(warning.formattedMessage || warning.message);
                    logUtils.log(chalk.yellow(normalizedWarningMsg));
                });
            }
        }
        return compiled;
    }
    /**
     * Gets the source tree hash for a file and its dependencies.
     * @param fileName Name of contract file.
     */
    private _getSourceTreeHash(importPath: string): Buffer {
        const contractSource = this._resolver.resolve(importPath);
        const dependencies = parseDependencies(contractSource);
        const sourceHash = ethUtil.sha3(contractSource.source);
        if (dependencies.length === 0) {
            return sourceHash;
        } else {
            const dependencySourceTreeHashes = _.map(dependencies, (dependency: string) =>
                this._getSourceTreeHash(dependency),
            );
            const sourceTreeHashesBuffer = Buffer.concat([sourceHash, ...dependencySourceTreeHashes]);
            const sourceTreeHash = ethUtil.sha3(sourceTreeHashesBuffer);
            return sourceTreeHash;
        }
    }
}
