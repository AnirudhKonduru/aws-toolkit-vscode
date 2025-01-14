/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs-extra'
import * as sinon from 'sinon'
import { makeTemporaryToolkitFolder } from '../../../shared/filesystemUtilities'
import * as model from '../../../codewhisperer/models/model'
import * as startTransformByQ from '../../../codewhisperer/commands/startTransformByQ'
import { HttpResponse } from 'aws-sdk'
import * as codeWhisperer from '../../../codewhisperer/client/codewhisperer'
import * as CodeWhispererConstants from '../../../codewhisperer/models/constants'
import { getTestWindow } from '../../shared/vscode/window'
import AdmZip from 'adm-zip'
import { stopTransformByQMessage } from '../../../codewhisperer/models/constants'
import { convertToTimeString, convertDateToTimestamp } from '../../../shared/utilities/textUtilities'
import path from 'path'
import { createTestWorkspaceFolder, toFile } from '../../testUtil'
import {
    NoJavaProjectsFoundError,
    NoMavenJavaProjectsFoundError,
    NoOpenProjectsError,
} from '../../../amazonqGumby/errors'
import {
    stopJob,
    pollTransformationJob,
    getHeadersObj,
    throwIfCancelled,
    zipCode,
} from '../../../codewhisperer/service/transformByQ/transformApiHandler'
import {
    validateOpenProjects,
    getOpenProjects,
} from '../../../codewhisperer/service/transformByQ/transformProjectValidationHandler'
import { TransformationCandidateProject } from '../../../codewhisperer/models/model'

describe('transformByQ', function () {
    let tempDir: string

    beforeEach(async function () {
        tempDir = await makeTemporaryToolkitFolder()
    })

    afterEach(async function () {
        sinon.restore()
        await fs.remove(tempDir)
    })

    it('WHEN converting short duration in milliseconds THEN converts correctly', async function () {
        const durationTimeString = convertToTimeString(10 * 1000)
        assert.strictEqual(durationTimeString, '10 sec')
    })

    it('WHEN converting medium duration in milliseconds THEN converts correctly', async function () {
        const durationTimeString = convertToTimeString(65 * 1000)
        assert.strictEqual(durationTimeString, '1 min 5 sec')
    })

    it('WHEN converting long duration in milliseconds THEN converts correctly', async function () {
        const durationTimeString = convertToTimeString(3700 * 1000)
        assert.strictEqual(durationTimeString, '1 hr 1 min 40 sec')
    })

    it('WHEN converting date object to timestamp THEN converts correctly', async function () {
        const date = new Date(2023, 0, 1, 0, 0, 0, 0)
        const timestamp = convertDateToTimestamp(date)
        assert.strictEqual(timestamp, '01/01/23, 12:00 AM')
    })

    it('WHEN job status is cancelled THEN error is thrown', async function () {
        model.transformByQState.setToCancelled()
        assert.throws(() => {
            throwIfCancelled()
        }, new model.TransformByQStoppedError())
    })

    it('WHEN job is stopped THEN status is updated to cancelled', async function () {
        const testWindow = getTestWindow()
        testWindow.onDidShowMessage(message => {
            if (message.message === stopTransformByQMessage) {
                message.selectItem(startTransformByQ.stopTransformByQButton)
            }
        })
        model.transformByQState.setToRunning()
        await startTransformByQ.stopTransformByQ('abc-123')
        assert.strictEqual(model.transformByQState.getStatus(), 'Cancelled')
    })

    it('WHEN validateProjectSelection called on non-Java project THEN throws error', async function () {
        const dummyCandidateProjects: TransformationCandidateProject[] = [
            {
                name: 'SampleProject',
                path: '/dummy/path/here',
            },
        ]
        await assert.rejects(async () => {
            await validateOpenProjects(dummyCandidateProjects)
        }, NoJavaProjectsFoundError)
    })

    it('WHEN validateProjectSelection called on Java project with no pom.xml THEN throws error', async function () {
        const folder = await createTestWorkspaceFolder()
        const dummyPath = path.join(folder.uri.fsPath, 'DummyFile.java')
        await toFile('', dummyPath)
        const findFilesStub = sinon.stub(vscode.workspace, 'findFiles')
        findFilesStub.onFirstCall().resolves([folder.uri])
        const dummyCandidateProjects: TransformationCandidateProject[] = [
            {
                name: 'SampleProject',
                path: folder.uri.fsPath,
            },
        ]

        await assert.rejects(async () => {
            await validateOpenProjects(dummyCandidateProjects)
        }, NoMavenJavaProjectsFoundError)
    })

    it('WHEN getOpenProjects called on non-empty workspace THEN returns open projects', async function () {
        sinon
            .stub(vscode.workspace, 'workspaceFolders')
            .get(() => [{ uri: vscode.Uri.file('/user/test/project/'), name: 'TestProject', index: 0 }])

        const openProjects = await getOpenProjects()
        assert.strictEqual(openProjects[0].name, 'TestProject')
    })

    it('WHEN getOpenProjects called on empty workspace THEN throws error', async function () {
        sinon.stub(vscode.workspace, 'workspaceFolders').get(() => undefined)

        await assert.rejects(async () => {
            await getOpenProjects()
        }, NoOpenProjectsError)
    })

    it('WHEN stop job called with valid jobId THEN stop API called', async function () {
        const stopJobStub = sinon.stub(codeWhisperer.codeWhispererClient, 'codeModernizerStopCodeTransformation')
        await stopJob('dummyId')
        sinon.assert.calledWithExactly(stopJobStub, { transformationJobId: 'dummyId' })
    })

    it('WHEN stop job that has not been started THEN stop API not called', async function () {
        const stopJobStub = sinon.stub(codeWhisperer.codeWhispererClient, 'codeModernizerStopCodeTransformation')
        await stopJob('')
        sinon.assert.notCalled(stopJobStub)
    })

    it('WHEN polling completed job THEN returns status as completed', async function () {
        const mockJobResponse = {
            $response: {
                data: {
                    transformationJob: { status: 'COMPLETED' },
                },
                requestId: 'requestId',
                hasNextPage: () => false,
                error: undefined,
                nextPage: () => undefined,
                redirectCount: 0,
                retryCount: 0,
                httpResponse: new HttpResponse(),
            },
            transformationJob: { status: 'COMPLETED' },
        }
        sinon.stub(codeWhisperer.codeWhispererClient, 'codeModernizerGetCodeTransformation').resolves(mockJobResponse)
        model.transformByQState.setToSucceeded()
        const status = await pollTransformationJob('dummyId', CodeWhispererConstants.validStatesForCheckingDownloadUrl)
        assert.strictEqual(status, 'COMPLETED')
    })

    it(`WHEN process history called THEN returns details of last run job`, async function () {
        const actual = startTransformByQ.processHistory(
            [],
            '01/01/23, 12:00 AM',
            'my-module',
            'Succeeded',
            '20 sec',
            '123'
        )
        const expected = [
            {
                timestamp: '01/01/23, 12:00 AM',
                module: 'my-module',
                status: 'Succeeded',
                duration: '20 sec',
                id: '123',
            },
        ]
        assert.deepStrictEqual(actual, expected)
    })

    it(`WHEN get headers for upload artifact to S3 THEN returns correct header with kms key arn`, function () {
        const actual = getHeadersObj('dummy-sha-256', 'dummy-kms-key-arn')
        const expected = {
            'x-amz-checksum-sha256': 'dummy-sha-256',
            'Content-Type': 'application/zip',
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': 'dummy-kms-key-arn',
        }
        assert.deepStrictEqual(actual, expected)
    })

    it(`WHEN get headers for upload artifact to S3 THEN returns correct headers without kms key arn`, function () {
        const actual = getHeadersObj('dummy-sha-256', '')
        const expected = {
            'x-amz-checksum-sha256': 'dummy-sha-256',
            'Content-Type': 'application/zip',
        }
        assert.deepStrictEqual(actual, expected)
    })

    it(`WHEN zip created THEN dependencies contains no .sha1 or .repositories files`, async function () {
        const m2Folders = [
            'com/groupid1/artifactid1/version1',
            'com/groupid1/artifactid1/version2',
            'com/groupid1/artifactid2/version1',
            'com/groupid2/artifactid1/version1',
            'com/groupid2/artifactid1/version2',
        ]
        // List of files that exist in m2 artifact directory
        const filesToAdd = [
            '_remote.repositories',
            'test-0.0.1-20240315.145420-18.pom',
            'test-0.0.1-20240315.145420-18.pom.sha1',
            'test-0.0.1-SNAPSHOT.pom',
            'maven-metadata-test-repo.xml',
            'maven-metadata-test-repo.xml.sha1',
            'resolver-status.properties',
        ]
        const expectedFilesAfterClean = [
            'test-0.0.1-20240315.145420-18.pom',
            'test-0.0.1-SNAPSHOT.pom',
            'maven-metadata-test-repo.xml',
            'resolver-status.properties',
        ]

        m2Folders.forEach(folder => {
            const folderPath = path.join(tempDir, folder)
            fs.mkdirSync(folderPath, { recursive: true })
            filesToAdd.forEach(file => {
                fs.writeFileSync(path.join(folderPath, file), 'sample content for the test file')
            })
        })

        const tempFileName = `testfile-${Date.now()}.zip`
        model.transformByQState.setProjectPath(tempDir)
        return zipCode({
            path: tempDir,
            name: tempFileName,
        }).then(zipFile => {
            const zip = new AdmZip(zipFile)
            const dependenciesToUpload = zip.getEntries().filter(entry => entry.entryName.startsWith('dependencies'))
            // Each dependency version folder contains each expected file, thus we multiply
            const expectedNumberOfDependencyFiles = m2Folders.length * expectedFilesAfterClean.length
            assert.strictEqual(expectedNumberOfDependencyFiles, dependenciesToUpload.length)
            dependenciesToUpload.forEach(dependency => {
                assert(expectedFilesAfterClean.includes(dependency.name))
            })
        })
    })
})
