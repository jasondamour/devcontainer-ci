import * as core from '@actions/core';
import path from 'path';
import {exec} from './exec';
import {
	devcontainer,
	DevContainerCliBuildArgs,
} from '../../common/src/dev-container-cli';
import {isSkopeoInstalled, copyImage} from './skopeo';

import {isDockerBuildXInstalled} from './docker';


// Helper function to convert empty string to undefined
function emptyStringAsUndefined(value: string): string | undefined {
	if (value === '') {
		return undefined;
	}
	return value;
}

// Helper function to get image digest from registry
// Does not work for manifests
async function getImageDigest(imageName: string): Promise<string | null> {
	console.log(`Getting image digest for ${imageName}`);
	try {
		const inspectCmd = await exec(
			'docker',
			['buildx', 'imagetools', 'inspect', '--raw', imageName],
			{silent: true}
		);
		if (inspectCmd.exitCode === 0) {
			const output = JSON.parse(inspectCmd.stdout.trim());
			// for simple images
			if (output.digest) {
				return output.digest;
			}
			// For manifests (i.e. for attestation)
			else if (output.manifests) {
				const manifest = output.manifests.find(
					(m: any) => m.mediaType === 'application/vnd.oci.image.manifest.v1+json'
				);
				if (manifest?.digest) {
					return manifest.digest;
				}
			}
		}
	} catch (error) {
		core.error(`Failed to get registry image digest for ${imageName}: ${error}`);
	}
	throw new Error(`Failed to get registry image digest for ${imageName}`);
}

export async function runMain(): Promise<void> {
	try {
		core.info('Starting...');
		core.saveState('hasRunMain', 'true');
		
		// Check prerequisites
		const buildXInstalled = await isDockerBuildXInstalled();
		if (!buildXInstalled) {
			core.setFailed(
				'docker buildx not available: add a step to set up with docker/setup-buildx-action - see https://github.com/devcontainers/ci/blob/main/docs/github-action.md',
			);
			return;
		}
		const skopeoInstalled = await isSkopeoInstalled();
		if (!skopeoInstalled) {
			core.setFailed('skopeo not available: add a step to set up with skopeo/install-action - see https://github.com/devcontainers/ci/blob/main/docs/github-action.md');
			return;
		}
		const devContainerCliInstalled = await devcontainer.isCliInstalled(exec);
		if (!devContainerCliInstalled) {
			const success = await devcontainer.installCli(exec);
			if (!success) {
				core.setFailed('@devcontainers/cli install failed!');
				return;
			}
		}

		// Parse inputs
		const checkoutPath: string = core.getInput('checkoutPath');
		const subFolder: string = core.getInput('subFolder');
		const relativeConfigFile = emptyStringAsUndefined(
			core.getInput('configFile'),
		);
		const cacheFrom: string[] = core.getMultilineInput('cacheFrom');
		const noCache: boolean = core.getBooleanInput('noCache');
		const cacheTo: string[] = core.getMultilineInput('cacheTo');
		const userDataFolder: string = core.getInput('userDataFolder');
				
		const log = (message: string): void => core.info(message);
		const workspaceFolder = path.resolve(checkoutPath, subFolder);
		const configFile = relativeConfigFile && path.resolve(checkoutPath, relativeConfigFile);
		const tagsInput = core.getMultilineInput('tags');
		const platforms = core.getMultilineInput('platform');
		const push = core.getBooleanInput('push');
		const pushByDigest = core.getBooleanInput('pushByDigest');
		// const output = `type=image,push-by-digest=true,name-canonical=true,push=true`;

		const tags: string[] = [];
		if (pushByDigest && platforms.length === 1) {
			const platformSlug = platforms[0].replace(/\//g, '-');
			tagsInput.forEach(tag => {
				tags.push(`${tag}-${platformSlug}`);
			});
		} else {
			tags.push(...tagsInput);
		}
		
		// Build the image
		const buildResult = await core.group('🏗️ build image', async () => {
			const args: DevContainerCliBuildArgs = {
				workspaceFolder: workspaceFolder,
				configFile: configFile,
				imageNames: tags,
				platforms: platforms,
				additionalCacheFroms: cacheFrom,
				userDataFolder: userDataFolder,
				noCache: noCache,
				cacheTo: cacheTo,
				push: push,
			};
			const result = await devcontainer.build(args, log);

			if (result.outcome !== 'success') {
				core.error(
					`Dev container build failed: ${result.message} (exit code: ${result.code})\n${result.description}`,
				);
				core.setFailed(result.message);
			}
			return result;
		});

		if (buildResult.outcome !== 'success') {
			return;
		}

		// Output the digests as a JSON
		if (pushByDigest) {
			const digest = await getImageDigest(tags[0]);
			if (digest !== null) {
				core.info(`Image digests: ${digest}`);
				core.setOutput('imageDigests', digest);
			}
		}
		
	} catch (error) {
		core.setFailed(error.message);
	}
}
