import * as _ from 'lodash';
import * as promisify from 'es6-promisify';
import * as publishRelease from 'publish-release';

import { constants } from '../constants';
import { Package } from '../types';
import { utils } from './utils';

import { readFileSync } from 'fs';
import * as path from 'path';
import { exec as execAsync } from 'promisify-child-process';

const publishReleaseAsync = promisify(publishRelease);
export async function publishReleaseNotesAsync(updatedPublishPackages: Package[]): Promise<void> {
    // Git push a tag representing this publish (publish-{commit-hash}) (truncate hash)
    const result = await execAsync('git log -n 1 --pretty=format:"%H"', { cwd: constants.monorepoRootPath });
    const latestGitCommit = result.stdout;
    const shortenedGitCommit = latestGitCommit.slice(0, 7);
    const tagName = `monorepo@${shortenedGitCommit}`;

    await execAsync(`git rev-parse ${tagName}`);
    await execAsync('git tag ${tagName}');

    await execAsync('git push origin ${tagName}');
    const releaseName = `0x monorepo - ${shortenedGitCommit}`;

    let assets: string[] = [];
    let aggregateNotes = '';
    _.each(updatedPublishPackages, pkg => {
        const notes = getReleaseNotesForPackage(pkg.packageJson.name, pkg.packageJson.version);
        if (_.isEmpty(notes)) {
            return; // don't include it
        }
        aggregateNotes += `### ${pkg.packageJson.name}@${pkg.packageJson.version}\n${notes}\n\n`;

        const packageAssets = _.get(pkg.packageJson, 'config.postpublish.assets');
        if (!_.isUndefined(packageAssets)) {
            assets = [...assets, ...packageAssets];
        }
    });
    const finalAssets = adjustAssetPaths(assets);

    utils.log('Publishing release notes ', releaseName, '...');
    // TODO: Currently publish-release doesn't let you specify the labels for each asset uploaded
    // Ideally we would like to name the assets after the package they are from
    // Source: https://github.com/remixz/publish-release/issues/39
    await publishReleaseAsync({
        token: constants.githubPersonalAccessToken,
        owner: '0xProject',
        tag: tagName,
        repo: '0x-monorepo',
        name: releaseName,
        notes: aggregateNotes,
        draft: false,
        prerelease: false,
        reuseRelease: true,
        reuseDraftOnly: false,
        assets: finalAssets,
    });
}

// Asset paths should described from the monorepo root. This method prefixes
// the supplied path with the absolute path to the monorepo root.
function adjustAssetPaths(assets: string[]): string[] {
    const finalAssets: string[] = [];
    _.each(assets, (asset: string) => {
        const finalAsset = `${constants.monorepoRootPath}/${asset}`;
        finalAssets.push(finalAsset);
    });
    return finalAssets;
}

function getReleaseNotesForPackage(packageName: string, version: string): string {
    const packageNameWithoutNamespace = packageName.replace('@0xproject/', '');
    const changelogJSONPath = path.join(
        constants.monorepoRootPath,
        'packages',
        packageNameWithoutNamespace,
        'CHANGELOG.json',
    );
    const changelogJSON = readFileSync(changelogJSONPath, 'utf-8');
    const changelogs = JSON.parse(changelogJSON);
    const latestLog = changelogs[0];
    // If only has a `Dependencies updated` changelog, we don't include it in release notes
    if (latestLog.changes.length === 1 && latestLog.changes[0].note === constants.dependenciesUpdatedMessage) {
        return '';
    }
    // We sanity check that the version for the changelog notes we are about to publish to Github
    // correspond to the new version of the package.
    // if (version !== latestLog.version) {
    //     throw new Error('Expected CHANGELOG.json latest entry version to coincide with published version.');
    // }
    let notes = '';
    _.each(latestLog.changes, change => {
        notes += `* ${change.note}`;
        if (change.pr) {
            notes += ` (#${change.pr})`;
        }
        notes += `\n`;
    });
    return notes;
}
