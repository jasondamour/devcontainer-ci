import * as core from '@actions/core';
import { runMain } from './main';
import { exec } from './exec';
import { devcontainer } from '../../common/src/dev-container-cli';
import { isDockerBuildXInstalled } from './docker';
import { copyImage } from './skopeo';
import { populateDefaults } from '../../common/src/envvars';

// Mock all dependencies
jest.mock('@actions/core');
jest.mock('./exec');
jest.mock('../../common/src/dev-container-cli');
jest.mock('./docker');
jest.mock('./skopeo');
jest.mock('../../common/src/envvars');

const mockCore = core as jest.Mocked<typeof core>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockDevcontainer = devcontainer as jest.Mocked<typeof devcontainer>;
const mockIsDockerBuildXInstalled = isDockerBuildXInstalled as jest.MockedFunction<typeof isDockerBuildXInstalled>;
const mockCopyImage = copyImage as jest.MockedFunction<typeof copyImage>;
const mockPopulateDefaults = populateDefaults as jest.MockedFunction<typeof populateDefaults>;

describe('DevContainer CI GitHub Action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock implementations
    mockIsDockerBuildXInstalled.mockResolvedValue(true);
    mockDevcontainer.isCliInstalled.mockResolvedValue(true);
    mockDevcontainer.installCli.mockResolvedValue(true);
    mockDevcontainer.build.mockResolvedValue({ outcome: 'success' });
    mockDevcontainer.up.mockResolvedValue({ 
      outcome: 'success', 
      containerId: 'test-container',
      remoteUser: 'vscode',
      remoteWorkspaceFolder: '/workspace'
    });
    mockDevcontainer.exec.mockResolvedValue(0);
    
    // Default core inputs
    mockCore.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        checkoutPath: '.',
        subFolder: '',
        configFile: '',
        env: '',
        inheritEnv: 'false',
        cacheFrom: '',
        noCache: 'false',
        cacheTo: '',
        skipContainerUserIdUpdate: 'false',
        userDataFolder: '',
        mounts: '',
        tags: '',
        platform: '',
      };
      return inputs[name] || '';
    });
    
    mockCore.getMultilineInput.mockImplementation((name: string) => {
      const inputs: Record<string, string[]> = {
        env: [],
        cacheFrom: [],
        cacheTo: [],
        mounts: [],
        tags: [],
        platform: []
      };
      return inputs[name] || [];
    });
    
    mockCore.getBooleanInput.mockImplementation((name: string) => {
      const inputs: Record<string, boolean> = {
        inheritEnv: false,
        noCache: false,
        skipContainerUserIdUpdate: false
      };
      return inputs[name] || false;
    });
    
    // Mock populateDefaults
    mockPopulateDefaults.mockReturnValue([]);
    
    // Mock core.group to execute the callback
    mockCore.group.mockImplementation(async (name: string, callback: () => Promise<any>) => {
      return await callback();
    });
  });

  describe('Simple use case - single tag, no platform', () => {
    it('should build and push a single platform image with single tag', async () => {
      // Setup
      mockCore.getMultilineInput.mockImplementation((name: string) => {
        if (name === 'tags') return ['myregistry/myimage:latest'];
        if (name === 'platform') return [];
        return [];
      });

      // Mock exec for getting registry image digest
      mockExec.mockImplementation(async (command: string, args: string[], options: any) => {
        if (command === 'docker' && args.includes('buildx') && args.includes('imagetools')) {
          return {
            exitCode: 0,
            stdout: 'Digest:    sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            stderr: ''
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: ''
        };
      });

      // Execute
      await runMain();

      // Verify
      expect(mockDevcontainer.build).toHaveBeenCalledWith(
        expect.objectContaining({
          imageName: ['myregistry/myimage:latest'],
          platform: undefined
        }),
        expect.any(Function)
      );
      
      expect(mockCore.setOutput).toHaveBeenCalledWith('imageDigests', expect.any(String));
      
      // Verify the digest output contains the expected structure
      const setOutputCalls = mockCore.setOutput.mock.calls;
      const imageDigestsCall = setOutputCalls.find(call => call[0] === 'imageDigests');
      expect(imageDigestsCall).toBeDefined();
      expect(imageDigestsCall).not.toBeUndefined();
      const digestsObj = JSON.parse(imageDigestsCall![1]);
      expect(digestsObj).toHaveProperty('myregistry/myimage:latest');
      expect(digestsObj['myregistry/myimage:latest']).toHaveProperty('default');
      expect(digestsObj['myregistry/myimage:latest'].default).toMatch(/^sha256:[a-f0-9]+$/);
    });
  });

  describe('Multiple tags use case - multiple tags, no platform', () => {
    it('should build and push to all listed tags', async () => {
      // Setup
      mockCore.getMultilineInput.mockImplementation((name: string) => {
        if (name === 'tags') return ['myregistry/myimage:latest', 'myregistry/myimage:v1.0', 'otherregistry/otherimage:dev'];
        if (name === 'platform') return [];
        return [];
      });

      // Mock exec for getting registry image digest
      mockExec.mockImplementation(async (command: string, args: string[], options: any) => {
        if (command === 'docker' && args.includes('buildx') && args.includes('imagetools')) {
          // Return different digests based on the image name being inspected
          const imageName = args[args.length - 1]; // Last argument is the image name
          let digest = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
          if (imageName.includes('v1.0')) {
            digest = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
          } else if (imageName.includes('otherregistry')) {
            digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
          }
          return {
            exitCode: 0,
            stdout: `Digest:    ${digest}`,
            stderr: ''
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: ''
        };
      });

      // Execute
      await runMain();

      // Verify
      expect(mockDevcontainer.build).toHaveBeenCalledWith(
        expect.objectContaining({
          imageName: ['myregistry/myimage:latest', 'myregistry/myimage:v1.0', 'otherregistry/otherimage:dev'],
          platform: undefined
        }),
        expect.any(Function)
      );
      
      // Verify the digest output contains the expected structure
      const setOutputCalls = mockCore.setOutput.mock.calls;
      const imageDigestsCall = setOutputCalls.find(call => call[0] === 'imageDigests');
      expect(imageDigestsCall).toBeDefined();
      expect(imageDigestsCall).not.toBeUndefined();
      const digestsObj = JSON.parse(imageDigestsCall![1]);
      
      // Verify all three tags are present
      expect(Object.keys(digestsObj)).toContain('myregistry/myimage:latest');
      expect(Object.keys(digestsObj)).toContain('myregistry/myimage:v1.0');
      expect(Object.keys(digestsObj)).toContain('otherregistry/otherimage:dev');
      
      // Verify each tag has the 'default' platform with a valid digest
      expect(digestsObj['myregistry/myimage:latest']).toHaveProperty('default');
      expect(digestsObj['myregistry/myimage:latest'].default).toMatch(/^sha256:[a-f0-9]+$/);
    });
  });

  describe('Simple Multi-platform use case - multiple tags, multiple platforms', () => {
    it('should build images for each platform and push manifest to each tag', async () => {
      // Setup
      mockCore.getMultilineInput.mockImplementation((name: string) => {
        if (name === 'tags') return ['myregistry/myimage:latest', 'myregistry/myimage:v1.0'];
        if (name === 'platform') return ['linux/amd64', 'linux/arm64'];
        return [];
      });

      // Mock successful build with image digests
      mockDevcontainer.build.mockResolvedValue({
        outcome: 'success',
        imageDigests: {
          'linux/amd64': 'sha256:amd64digest123',
          'linux/arm64': 'sha256:arm64digest456'
        }
      });

      // Execute
      await runMain();

      // Verify
      expect(mockDevcontainer.build).toHaveBeenCalledWith(
        expect.objectContaining({
          imageName: ['myregistry/myimage:latest', 'myregistry/myimage:v1.0'],
          platform: 'linux/amd64,linux/arm64'
        }),
        expect.any(Function)
      );
      
      expect(mockCore.setOutput).toHaveBeenCalledWith('imageDigests', 
        JSON.stringify({
          'myregistry/myimage:latest': {
            'linux/amd64': 'sha256:amd64digest123',
            'linux/arm64': 'sha256:arm64digest456'
          },
          'myregistry/myimage:v1.0': {
            'linux/amd64': 'sha256:amd64digest123',
            'linux/arm64': 'sha256:arm64digest456'
          }
        })
      );
    });
  });

  describe('Multi-runner multi-platform use case - multiple tags, single platform', () => {
    it('should build for single platform and push with platform suffix', async () => {
      // Setup
      mockCore.getMultilineInput.mockImplementation((name: string) => {
        if (name === 'tags') return ['myregistry/myimage:latest', 'myregistry/myimage:v1.0'];
        if (name === 'platform') return ['linux/arm64'];
        return [];
      });

      // Mock successful build
      mockDevcontainer.build.mockResolvedValue({
        outcome: 'success'
      });

      // Mock exec for getting registry image digest
      mockExec.mockImplementation(async (command: string, args: string[], options: any) => {
        if (command === 'docker' && args.includes('buildx') && args.includes('imagetools')) {
          // Return different digests based on the image name being inspected
          const imageName = args[args.length - 1]; // Last argument is the image name
          let digest = 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
          if (imageName.includes('v1.0')) {
            digest = 'sha256:123456fedcba098765432fedcba123456fedcba098765432fedcba1234567890';
          }
          return {
            exitCode: 0,
            stdout: `Digest:    ${digest}`,
            stderr: ''
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: ''
        };
      });

      // Execute
      await runMain();

      // Verify
      expect(mockDevcontainer.build).toHaveBeenCalledWith(
        expect.objectContaining({
          imageName: ['myregistry/myimage:latest', 'myregistry/myimage:v1.0'],
          platform: 'linux/arm64'
        }),
        expect.any(Function)
      );

      // Should inspect the registry image to get digest
      expect(mockExec).toHaveBeenCalledWith(
        'docker',
        ['buildx', 'imagetools', 'inspect', 'myregistry/myimage:latest'],
        { silent: true }
      );
      
      // Verify the digest output contains the platform-specific structure
      const setOutputCalls = mockCore.setOutput.mock.calls;
      const imageDigestsCall = setOutputCalls.find(call => call[0] === 'imageDigests');
      expect(imageDigestsCall).toBeDefined();
      expect(imageDigestsCall).not.toBeUndefined();
      const digestsObj = JSON.parse(imageDigestsCall![1]);
      
      // Verify both tags are present
      expect(Object.keys(digestsObj)).toContain('myregistry/myimage:latest');
      expect(Object.keys(digestsObj)).toContain('myregistry/myimage:v1.0');
      
      // Verify each tag has the linux/arm64 platform with a valid digest
      expect(digestsObj['myregistry/myimage:latest']).toHaveProperty('linux/arm64');
      expect(digestsObj['myregistry/myimage:latest']['linux/arm64']).toMatch(/^sha256:[a-f0-9]+$/);
    });
  });

  describe('Error handling', () => {
    it('should fail when docker buildx is not installed', async () => {
      mockIsDockerBuildXInstalled.mockResolvedValue(false);
      
      await runMain();
      
      expect(mockCore.warning).toHaveBeenCalledWith(
        expect.stringContaining('docker buildx not available')
      );
      expect(mockCore.setFailed).not.toHaveBeenCalled();
    });

    it('should fail when devcontainer CLI is not installed and installation fails', async () => {
      mockDevcontainer.isCliInstalled.mockResolvedValue(false);
      mockDevcontainer.installCli.mockResolvedValue(false);
      
      await runMain();
      
      expect(mockCore.setFailed).toHaveBeenCalledWith('@devcontainers/cli install failed!');
    });

    it('should fail when build fails', async () => {
      mockCore.getMultilineInput.mockImplementation((name: string) => {
        if (name === 'tags') return ['myregistry/myimage:latest'];
        if (name === 'platform') return [];
        return [];
      });
      
      mockDevcontainer.build.mockResolvedValue({
        outcome: 'error',
        code: 1,
        message: 'Build failed',
        description: 'Build process failed'
      });
      
      await runMain();
      
      expect(mockCore.setFailed).toHaveBeenCalledWith('Build failed');
    });

  });

});
