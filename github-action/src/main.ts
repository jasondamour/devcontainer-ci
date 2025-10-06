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
	try {
		const inspectCmd = await exec(
			'docker',
			['buildx', 'imagetools', 'inspect', '--raw', imageName],
			{silent: true}
		);
		
		if (inspectCmd.exitCode === 0) {
			const output = JSON.parse(inspectCmd.stdout.trim());
			if (output.digest) {
				return output.digest;
			}
		}
	} catch (error) {
		core.warning(`Failed to get registry image digest for ${imageName}: ${error}`);
	}
	return null;
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
		const output = 'type=oci,dest=/tmp/output.tar';
		const tagsInput = core.getMultilineInput('tags');
		const platforms = core.getMultilineInput('platform');
		const push = core.getBooleanInput('push');

		const multiRunnerBuild = core.getBooleanInput('multiRunnerBuild');
		if (multiRunnerBuild && platforms.length !== 1) {
			core.setFailed('if multiRunnerBuild is true, one platform must be specified');
			return;
		} 
		
		const imageData: {tag: string, platform: string, tagWithPlatform: string}[] = [];
		tagsInput.forEach(tag => { 
			platforms.forEach(platform => {
				imageData.push({
					tag: tag,
					platform: platform,
					tagWithPlatform: `${tag}-${platform.replace(/\//g, '-')}`
				});
			});
		});
		
		const tags = multiRunnerBuild ?
			imageData.flatMap(image => image.tagWithPlatform) :
			tagsInput;

		
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
				output: output,
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

		// Push the image
		if (push) {
			await core.group('📌 push image', async () => {
				for (const tag of tags) {
					core.info(`Pushing image '${tag}'...`);
					const dest = `docker://${tag}`;
					await copyImage(true, output, dest);
				}
				core.info('Images pushed successfully');
			});
		} else {
			core.info('Images not pushed');
			return;
		}

		// Output the digests as a JSON
		if (multiRunnerBuild) {
			const digestsObj: Record<string, Record<string, string>> = {};
			await Promise.all(imageData.map(async image => {
				const digest = await getImageDigest(image.tagWithPlatform);
				if (digest !== null) {
					digestsObj[image.tag] = {
						[image.platform]: digest
					};
				}
			}));
			if (Object.keys(digestsObj).length > 0) {
				const digestsJson = JSON.stringify(digestsObj);
				core.info(`Image digests: ${digestsJson}`);
				core.setOutput('imageDigests', digestsJson);
			}
		}
		
	} catch (error) {
		core.setFailed(error.message);
	}
}
