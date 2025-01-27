import React, { act } from 'react';
import cloneDeep from 'lodash/cloneDeep';
import { mount } from 'enzyme';
import noop from 'lodash/noop';
import userEvent from '@testing-library/user-event';
import * as utils from '../utils';
import { render, screen, waitFor, within } from '../../../test-utils/testing-library';
import { ContentExplorerComponent as ContentExplorer, ContentExplorerProps } from '../ContentExplorer';
import UploadDialog from '../../common/upload-dialog';
import CONTENT_EXPLORER_FOLDER_FIELDS_TO_FETCH from '../constants';
import { VIEW_MODE_GRID } from '../../../constants';
import { mockRootFolder, mockRootFolderSharedLink } from '../stories/__mocks__/mockRootFolder';

jest.mock('../../../utils/Xhr', () => {
    return jest.fn().mockImplementation(() => {
        return {
            get: jest.fn(({ url }) => {
                switch (url) {
                    case 'https://api.box.com/2.0/folders/69083462919':
                        return Promise.resolve({ data: mockRootFolder });
                    case 'https://api.box.com/2.0/folders/73426618530':
                        return Promise.resolve({ data: mockRootFolderSharedLink });
                    default:
                        return Promise.reject(new Error('Not Found'));
                }
            }),
            put: jest.fn(({ url, data }) => {
                switch (url) {
                    case 'https://api.box.com/2.0/folders/73426618530':
                        return Promise.resolve({ data });
                    default:
                        return Promise.reject(new Error('Not Found'));
                }
            }),
            delete: jest.fn(({ url }) => {
                switch (url) {
                    case 'https://api.box.com/2.0/folders/73426618530?recursive=true':
                        return Promise.resolve({ data: {} });
                    default:
                        return Promise.reject(new Error('Not Found'));
                }
            }),
            abort: jest.fn(),
        };
    });
});

jest.mock(
    '@box/react-virtualized/dist/es/AutoSizer',
    () =>
        ({ children }) =>
            children({ height: 600, width: 600 }),
);

describe('elements/content-explorer/ContentExplorer', () => {
    let rootElement: any;
    const getWrapper = (props = {}) =>
        mount(<ContentExplorer rootFolderId="123" token="token" {...props} />, { attachTo: rootElement });

    const renderComponent = (props: Partial<ContentExplorerProps> = {}) => {
        return render(<ContentExplorer rootFolderId="69083462919" token="token" {...props} />);
    };

    beforeEach(() => {
        rootElement = document.createElement('div');
        rootElement.appendChild(document.createElement('div'));
        document.body.appendChild(rootElement);
    });

    afterEach(() => {
        document.body.removeChild(rootElement);
    });

    describe('render', () => {
        test('should render the component', async () => {
            renderComponent();

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            expect(screen.getByRole('button', { name: 'Preview Test Folder' })).toBeInTheDocument();
            expect(screen.getByText('Name')).toBeInTheDocument();
            expect(screen.getByText('Modified')).toBeInTheDocument();
            expect(screen.getByText('Size')).toBeInTheDocument();
            expect(screen.getByText('An Ordered Folder')).toBeInTheDocument();
            expect(screen.getByText('Modified Tue Apr 16 2019 by Preview')).toBeInTheDocument();
        });

        test('shoulder render grid view mode', async () => {
            renderComponent();

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            expect(screen.getByRole('button', { name: 'Preview Test Folder' })).toBeInTheDocument();

            const gridButton = screen.getByRole('button', { name: 'Switch to Grid View' });
            await userEvent.click(gridButton);

            expect(screen.queryByText('Name')).not.toBeInTheDocument();
            expect(screen.queryByText('Modified')).not.toBeInTheDocument();
            expect(screen.queryByText('Size')).not.toBeInTheDocument();

            expect(screen.getByText('An Ordered Folder')).toBeInTheDocument();
            expect(screen.getByText('Modified Tue Apr 16 2019 by Preview')).toBeInTheDocument();
            expect(screen.getByText('193.24 MB')).toBeInTheDocument();
        });
    });

    describe('Upload', () => {
        test('should upload a new item', async () => {
            renderComponent({ canUpload: true });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const addButton = screen.getByRole('button', { name: 'Add' });
            await userEvent.click(addButton);

            const uploadButton = screen.getByText('Upload');
            await userEvent.click(uploadButton);

            expect(screen.getByText('Drag and drop files')).toBeInTheDocument();
            expect(screen.getByText('Browse your device')).toBeInTheDocument();
        });

        test('should not render upload button when canUpload is false', async () => {
            renderComponent({ canUpload: false });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const addButton = screen.getByRole('button', { name: 'Add' });
            await userEvent.click(addButton);

            expect(screen.queryByText('Upload')).not.toBeInTheDocument();
        });
    });

    describe('New Folder', () => {
        test('should open new folder dialog', async () => {
            const onCreate = jest.fn();
            renderComponent({ canCreateNewFolder: true, onCreate });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const addButton = screen.getByRole('button', { name: 'Add' });
            await userEvent.click(addButton);

            const uploadButton = screen.getByText('New Folder');
            await userEvent.click(uploadButton);

            expect(screen.getByText('Please enter a name.')).toBeInTheDocument();

            expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        });

        test('should not render new folder button when canCreateNewFolder is false', async () => {
            renderComponent({ canCreateNewFolder: false });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const addButton = screen.getByRole('button', { name: 'Add' });
            await userEvent.click(addButton);

            expect(screen.queryByText('New Folder')).not.toBeInTheDocument();
        });
    });

    describe('Rename item', () => {
        test('should open rename dialog', async () => {
            const onRename = jest.fn();
            renderComponent({ onRename });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[0];
            await userEvent.click(moreOptionsButton);
            let renameButton = screen.getByText('Rename');
            expect(renameButton).toBeInTheDocument();
            await userEvent.click(renameButton);

            const input = screen.getByRole('textbox', { name: 'Please enter a new name for An Ordered Folder:' });
            expect(input).toBeInTheDocument();

            renameButton = screen.getByRole('button', { name: 'Rename' });
            expect(renameButton).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
            await userEvent.clear(input);
            await userEvent.type(input, 'New Ordered Folder');
            await userEvent.click(renameButton);

            expect(onRename).toHaveBeenCalledWith({
                ...mockRootFolder.item_collection.entries[0],
                selected: true,
                thumbnailUrl: null,
            });
        });

        test('should not render rename button when canRename is false', async () => {
            renderComponent({ canRename: false });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[0];
            await userEvent.click(moreOptionsButton);

            expect(screen.queryByText('Rename')).not.toBeInTheDocument();
        });
    });

    describe('Share', () => {
        test('should create share link', async () => {
            renderComponent({ isSmall: true });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[0];
            await userEvent.click(moreOptionsButton);

            const shareButton = within(screen.getByRole('menu')).getByText('Share');
            expect(shareButton).toBeInTheDocument();
            await userEvent.click(shareButton);
            // const shareButton = screen.getByRole('button', { name: 'Share' });
            // expect(shareButton).toBeInTheDocument();
            // await userEvent.click(shareButton, { pointerEventsCheck: 0 });
            screen.debug(undefined, 30000);

            // expect(await screen.findByText('Please enter a new name for An Ordered Folder:')).toBeInTheDocument();
            // expect(screen.getByPlaceholderText('https://exmaple.com/share-link')).toBeInTheDocument();

            //
            // expect(screen.getByRole('button', { name: 'COPY' })).toBeInTheDocument();
            // expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        });

        test('should not render share button when canShare is false', async () => {
            renderComponent({ canShare: false });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[0];
            await userEvent.click(moreOptionsButton);

            expect(screen.queryByText('Share')).not.toBeInTheDocument();
        });
    });

    describe('Delete', () => {
        test('should delete item', async () => {
            const onDelete = jest.fn();
            renderComponent({ canCreateNewFolder: true, onDelete });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[0];
            await userEvent.click(moreOptionsButton);
            const deleteButton = screen.getByText('Delete');
            expect(deleteButton).toBeInTheDocument();
            await userEvent.click(deleteButton);

            screen.debug(undefined, 30000);

            expect(
                screen.getByText('Are you sure you want to delete An Ordered Folder and all its contents?'),
            ).toBeInTheDocument();

            const deleteButtonConfirm = screen.getByRole('button', { name: 'Delete' });
            expect(deleteButtonConfirm).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

            await userEvent.click(deleteButtonConfirm);

            expect(onDelete).toHaveBeenCalledWith([
                { ...mockRootFolder.item_collection.entries[0], selected: true, thumbnailUrl: null },
            ]);
        });

        test('should not render delete button when canDelete is false', async () => {
            renderComponent({ canDelete: false });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[0];
            await userEvent.click(moreOptionsButton);

            expect(screen.queryByText('Delete')).not.toBeInTheDocument();
        });
    });

    describe('Download', () => {
        test('should download item', async () => {
            const onDownload = jest.fn();
            renderComponent({ onDownload });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[3];
            await userEvent.click(moreOptionsButton);

            const downloadButton = screen.getByText('Download');
            expect(downloadButton).toBeInTheDocument();
            await userEvent.click(downloadButton);

            expect(onDownload).toHaveBeenCalledWith([
                {
                    ...mockRootFolder.item_collection.entries[3],
                    selected: true,
                    thumbnailUrl:
                        'https://dl.boxcloud.com/api/2.0/internal_files/416044542013/versions/439751948413/representations/jpg_1024x1024/content/?access_token=token',
                },
            ]);
        });

        test('should not render download button when canDownload is false', async () => {
            renderComponent({ canDownload: false });

            await waitFor(() => {
                expect(screen.getByTestId('content-explorer')).toBeInTheDocument();
                expect(screen.getByText('Please wait while the items load...')).toBeInTheDocument();
            });

            const moreOptionsButton = screen.getAllByRole('button', { name: 'More options' })[3];
            await userEvent.click(moreOptionsButton);

            expect(screen.queryByText('Download')).not.toBeInTheDocument();
        });
    });

    describe('metadata', () => {
        test('should render metadata view', async () => {});
    });

    xdescribe('old', () => {
        describe('uploadSuccessHandler()', () => {
            test('should force reload the files list', () => {
                const wrapper = getWrapper();
                const instance = wrapper.instance();

                act(() => {
                    instance.setState({
                        currentCollection: {
                            id: '123',
                        },
                    });
                });

                instance.fetchFolder = jest.fn();

                act(() => {
                    instance.uploadSuccessHandler();
                });

                expect(instance.fetchFolder).toHaveBeenCalledWith('123', false);
            });
        });

        describe('recentsSuccessCallback()', () => {
            const collection = { name: 'collection ' } as const;

            test('navigation event should not be triggered if argument set to false', () => {
                const wrapper = getWrapper();
                const instance = wrapper.instance();
                instance.updateCollection = jest.fn();

                instance.recentsSuccessCallback(collection, false);
                expect(instance.updateCollection).toHaveBeenCalledWith(collection);
            });

            test('navigation event should be triggered if argument set to true ', () => {
                const wrapper = getWrapper();
                const instance = wrapper.instance();
                instance.updateCollection = jest.fn();

                instance.recentsSuccessCallback(collection, true);
                expect(instance.updateCollection).toHaveBeenCalledWith(
                    collection,
                    undefined,
                    instance.finishNavigation,
                );
            });
        });

        describe('updateCollection()', () => {
            describe('selection', () => {
                const item1 = { id: 1 } as const;
                const item2 = { id: 2 } as const;
                const collection = { boxItem: {}, id: '0', items: [item1, item2], name: 'name' } as const;

                let wrapper: any;
                let instance: any;

                beforeEach(() => {
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.setState({ currentCollection: collection, selected: undefined });
                    instance.setState = jest.fn();
                });

                test('should set same collection and no selected item to state if no items present in collection', () => {
                    const noItemsCollection = { ...collection, items: undefined } as const;
                    const expectedCollection = { ...collection, items: [] } as const;

                    instance.updateCollection(noItemsCollection, { id: 3 }).then(() => {
                        expect(instance.setState).toHaveBeenCalledWith(
                            { currentCollection: expectedCollection, selected: undefined },
                            noop,
                        );
                    });
                });

                test('should update the collection items selected to false even if selected item is not in the collection', () => {
                    const expectedItem1 = { id: 1, selected: false, thumbnailUrl: null } as const;
                    const expectedItem2 = { id: 2, selected: false, thumbnailUrl: null } as const;
                    const expectedCollection = {
                        boxItem: {},
                        id: '0',
                        items: [expectedItem1, expectedItem2],
                        name: 'name',
                    } as const;

                    instance.updateCollection(collection, { id: 3 }).then(() => {
                        expect(instance.setState).toHaveBeenCalledWith(
                            { currentCollection: expectedCollection, selected: undefined },
                            noop,
                        );
                    });
                });

                test('should update the collection items selected to false except for the selected item in the collection', () => {
                    const expectedItem1 = { id: 1, selected: false, thumbnailUrl: null } as const;
                    const expectedItem2 = { id: 2, selected: true, thumbnailUrl: null } as const;
                    const expectedCollection = {
                        boxItem: {},
                        id: '0',
                        items: [expectedItem1, expectedItem2],
                        name: 'name',
                    } as const;

                    instance.updateCollection(collection, { id: 2 }).then(() => {
                        expect(instance.setState).toHaveBeenCalledWith(
                            { currentCollection: expectedCollection, selected: expectedItem2 },
                            noop,
                        );
                    });
                });

                test('should update the selected item in the collection', () => {
                    const expectedItem1 = { id: 1, selected: false, thumbnailUrl: null } as const;
                    const expectedItem2 = {
                        id: 2,
                        selected: true,
                        newProperty: 'newProperty',
                        thumbnailUrl: null,
                    } as const;
                    const expectedCollection = {
                        boxItem: {},
                        id: '0',
                        items: [expectedItem1, expectedItem2],
                        name: 'name',
                    } as const;

                    instance.updateCollection(collection, { id: 2, newProperty: 'newProperty' }).then(() => {
                        expect(instance.setState).toHaveBeenCalledWith(
                            {
                                currentCollection: expectedCollection,
                                selected: { ...expectedItem2, newProperty: 'newProperty' },
                            },
                            noop,
                        );
                    });
                });
            });

            describe('thumbnails', () => {
                const baseItem = { id: '1', selected: true, type: 'file' } as const;
                const baseCollection = {
                    boxItem: {},
                    id: '0',
                    items: [baseItem],
                    name: 'collectionName',
                    selected: baseItem,
                } as const;
                const thumbnailUrl = 'thumbnailUrl';
                const callback = jest.fn();

                let wrapper: any;
                let instance: any;
                let collection: any;
                let item: any;

                beforeEach(() => {
                    collection = cloneDeep(baseCollection);
                    item = cloneDeep(baseItem);
                });

                test('should add thumbnailUrl', () => {
                    const getThumbnailUrl = jest.fn().mockReturnValue(thumbnailUrl);
                    const getFileAPI = jest.fn().mockReturnValue({
                        getThumbnailUrl,
                    });
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.api = { getFileAPI };
                    instance.setState = jest.fn();

                    return instance.updateCollection(collection, item, callback).then(() => {
                        const newSelected = { ...item, thumbnailUrl } as const;
                        const newCollection = { ...collection, items: [newSelected] } as const;

                        expect(instance.setState).toHaveBeenCalledWith(
                            { currentCollection: newCollection, selected: newSelected },
                            callback,
                        );
                    });
                });
                test('should not call attemptThumbnailGeneration if thumbnail is null', () => {
                    const getThumbnailUrl = jest.fn().mockReturnValue(null);
                    const getFileAPI = jest.fn().mockReturnValue({
                        getThumbnailUrl,
                    });

                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.api = { getFileAPI };
                    instance.setState = jest.fn();
                    instance.attemptThumbnailGeneration = jest.fn();

                    return instance.updateCollection(collection, item, callback).then(() => {
                        expect(instance.attemptThumbnailGeneration).not.toHaveBeenCalled();
                    });
                });

                test('should not call attemptThumbnailGeneration if isThumbnailReady is true', () => {
                    const getThumbnailUrl = jest.fn().mockReturnValue(null);
                    const getFileAPI = jest.fn().mockReturnValue({
                        getThumbnailUrl,
                    });

                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.api = { getFileAPI };
                    instance.setState = jest.fn();
                    instance.attemptThumbnailGeneration = jest.fn();
                    utils.isThumbnailReady = jest.fn().mockReturnValue(true);

                    return instance.updateCollection(collection, item, callback).then(() => {
                        expect(instance.attemptThumbnailGeneration).not.toHaveBeenCalled();
                    });
                });

                test('should call attemptThumbnailGeneration if isThumbnailReady is false', () => {
                    const getThumbnailUrl = jest.fn().mockReturnValue(thumbnailUrl);
                    const getFileAPI = jest.fn().mockReturnValue({
                        getThumbnailUrl,
                    });

                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.api = { getFileAPI };
                    instance.setState = jest.fn();
                    instance.attemptThumbnailGeneration = jest.fn();
                    utils.isThumbnailReady = jest.fn().mockReturnValue(false);

                    return instance.updateCollection(collection, item, callback).then(() => {
                        expect(instance.attemptThumbnailGeneration).toHaveBeenCalled();
                    });
                });

                test('should not call attemptThumbnailGeneration or getThumbnailUrl if item is not file', () => {
                    const getThumbnailUrl = jest.fn().mockReturnValue(thumbnailUrl);
                    const getFileAPI = jest.fn().mockReturnValue({
                        getThumbnailUrl,
                    });

                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.api = { getFileAPI };
                    instance.setState = jest.fn();
                    instance.attemptThumbnailGeneration = jest.fn();
                    utils.isThumbnailReady = jest.fn().mockReturnValue(false);

                    collection.items[0].type = 'folder';
                    return instance.updateCollection(collection, item, callback).then(() => {
                        expect(instance.attemptThumbnailGeneration).not.toHaveBeenCalled();
                        expect(getThumbnailUrl).not.toHaveBeenCalled();
                    });
                });
            });

            describe('attemptThumbnailGeneration()', () => {
                const entry1 = { name: 'entry1', updated: false } as const;
                const entry2 = { name: 'entry2', updated: false } as const;
                const itemWithRepresentation = { representations: { entries: [entry1, entry2] } } as const;
                const itemWithoutRepresentation = { name: 'item' } as const;

                let wrapper: any;
                let instance: any;

                test('should not update item in collection if grid view is not enabled', () => {
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.updateItemInCollection = jest.fn();
                    return instance.attemptThumbnailGeneration(itemWithRepresentation).then(() => {
                        expect(instance.updateItemInCollection).not.toHaveBeenCalled();
                    });
                });

                test('should not update item in collection if item does not have representation', () => {
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.updateItemInCollection = jest.fn();
                    return instance.attemptThumbnailGeneration(itemWithoutRepresentation).then(() => {
                        expect(instance.updateItemInCollection).not.toHaveBeenCalled();
                    });
                });

                test('should not update item in collection if updated representation matches given representation', () => {
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.updateItemInCollection = jest.fn();
                    instance.api = {
                        getFileAPI: jest
                            .fn()
                            .mockReturnValue({ generateRepresentation: jest.fn().mockReturnValue(entry1) }),
                    };
                    return instance.attemptThumbnailGeneration(itemWithRepresentation).then(() => {
                        expect(instance.updateItemInCollection).not.toHaveBeenCalled();
                    });
                });

                test('should update item in collection if representation is updated', () => {
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    instance.updateItemInCollection = jest.fn();
                    instance.api = {
                        getFileAPI: jest.fn().mockReturnValue({
                            generateRepresentation: jest.fn().mockReturnValue({ ...entry1, updated: true }),
                        }),
                    };
                    return instance.attemptThumbnailGeneration(itemWithRepresentation).then(() => {
                        expect(instance.updateItemInCollection).toHaveBeenCalledWith({
                            ...itemWithRepresentation,
                            representations: { entries: [{ ...entry1, updated: true }, entry2] },
                        });
                    });
                });
            });

            describe('updateItemInCollection()', () => {
                const item1 = { id: '1', updated: false } as const;
                const item2 = { id: '2', updated: false } as const;
                const baseCollection = { items: [item1, item2] } as const;

                let wrapper: any;
                let instance: any;

                beforeEach(() => {
                    wrapper = getWrapper();
                    instance = wrapper.instance();
                    act(() => {
                        instance.setState({ currentCollection: baseCollection });
                    });
                    instance.setState = jest.fn();
                });

                test('should not update collection if matching id is not present in collection', () => {
                    const item3 = { id: '3', updated: true } as const;
                    act(() => {
                        instance.updateItemInCollection(item3);
                    });
                    expect(instance.setState).toHaveBeenCalledWith({ currentCollection: baseCollection });
                });

                test('should update collection if matching id is present in collection', () => {
                    const newItem2 = { id: '2', updated: true } as const;
                    act(() => {
                        instance.updateItemInCollection(newItem2);
                    });
                    expect(instance.setState).toHaveBeenCalledWith({
                        currentCollection: { ...baseCollection, items: [item1, newItem2] },
                    });
                });
            });
        });

        describe('updateMetadata()', () => {
            test('should update metadata for given Box item, field, old and new values', () => {
                const item: Record<string, any> = {};
                const field = 'amount';
                const oldValue = 'abc';
                const newValue = 'pqr';

                const wrapper = getWrapper();
                const instance = wrapper.instance();
                instance.metadataQueryAPIHelper = {
                    updateMetadata: jest.fn(),
                };

                instance.updateMetadata(item, field, oldValue, newValue);
                expect(instance.metadataQueryAPIHelper.updateMetadata).toHaveBeenCalledWith(
                    item,
                    field,
                    oldValue,
                    newValue,
                    expect.any(Function),
                    instance.errorCallback,
                );
            });
        });

        describe('updateMetadataSuccessCallback()', () => {
            test('should correctly update the current collection and set the state', () => {
                const boxItem = { id: 2 } as const;
                const field = 'amount';
                const newValue = 111.22;
                const collectionItem1 = {
                    id: 1,
                    metadata: {
                        enterprise: {
                            fields: [
                                {
                                    name: 'name',
                                    key: 'name',
                                    value: 'abc',
                                    type: 'string',
                                },
                                {
                                    name: 'amount',
                                    key: 'amount',
                                    value: 100.34,
                                    type: 'float',
                                },
                            ],
                        },
                    },
                };
                const collectionItem2 = {
                    id: 2,
                    metadata: {
                        enterprise: {
                            fields: [
                                {
                                    name: 'name',
                                    key: 'name',
                                    value: 'pqr',
                                    type: 'string',
                                },
                                {
                                    name: 'amount',
                                    key: 'amount',
                                    value: 354.23,
                                    type: 'float',
                                },
                            ],
                        },
                    },
                };
                const clonedCollectionItem2 = cloneDeep(collectionItem2);
                const nextMarker = 'markermarkermarkermarkermarkermarker';
                const currentCollection = {
                    items: [collectionItem1, collectionItem2],
                    nextMarker,
                } as const;
                const wrapper = getWrapper();

                // update the metadata
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                clonedCollectionItem2.metadata.enterprise.fields.find(item => item.key === field).value = newValue;

                const updatedItems = [collectionItem1, clonedCollectionItem2];

                act(() => {
                    wrapper.setState({ currentCollection });
                });

                const instance = wrapper.instance();
                instance.setState = jest.fn();
                act(() => {
                    instance.updateMetadataSuccessCallback(boxItem, field, newValue);
                });
                expect(instance.setState).toHaveBeenCalledWith({
                    currentCollection: {
                        items: updatedItems,
                        nextMarker,
                        percentLoaded: 100,
                    },
                });
            });
        });

        describe('handleSharedLinkSuccess()', () => {
            const getApiShareMock = jest.fn().mockImplementation((item: any, access: any, callback: any) => callback());
            const getApiMock = jest.fn().mockReturnValue({ share: getApiShareMock });
            const updateCollectionMock = jest.fn();

            const boxItem = {
                shared_link: 'not null',
                permissions: {
                    can_share: true,
                    can_set_share_access: false,
                },
                type: 'file',
            } as const;

            let wrapper: any;
            let instance: any;

            beforeEach(() => {
                wrapper = getWrapper();
                instance = wrapper.instance();
                instance.api = { getAPI: getApiMock };
                instance.updateCollection = updateCollectionMock;
            });

            afterEach(() => {
                getApiMock.mockClear();
                getApiShareMock.mockClear();
                updateCollectionMock.mockClear();
            });

            test('should create shared link if it does not exist', async () => {
                await instance.handleSharedLinkSuccess({ ...boxItem, shared_link: null });

                expect(getApiMock).toBeCalledTimes(1);
                expect(getApiShareMock).toBeCalledTimes(1);
                expect(updateCollectionMock).toBeCalledTimes(1);
            });

            test('should not create shared link if it already exists', async () => {
                await instance.handleSharedLinkSuccess(boxItem);

                expect(getApiMock).not.toBeCalled();
                expect(getApiShareMock).not.toBeCalled();
                expect(updateCollectionMock).toBeCalledTimes(1);
            });
        });

        describe('render()', () => {
            test('should render UploadDialog with contentUploaderProps', () => {
                const contentUploaderProps = {
                    apiHost: 'https://api.box.com',
                    chunked: false,
                } as const;
                const wrapper = getWrapper({ canUpload: true, contentUploaderProps });
                act(() => {
                    wrapper.setState({
                        currentCollection: {
                            permissions: {
                                can_upload: true,
                            },
                        },
                    });
                });
                const uploadDialogElement = wrapper.find(UploadDialog);
                expect(uploadDialogElement.length).toBe(1);
                expect(uploadDialogElement.prop('contentUploaderProps')).toEqual(contentUploaderProps);
            });

            test('should render test id for e2e testing', () => {
                const wrapper = getWrapper();
                expect(wrapper.find('[data-testid="content-explorer"]')).toHaveLength(1);
            });
        });

        describe('deleteCallback', () => {
            const getApiDeleteMock = jest.fn();
            const getApiMock = jest.fn().mockReturnValue({ deleteItem: getApiDeleteMock });
            const refreshCollectionMock = jest.fn();
            const onDeleteMock = jest.fn();
            const boxItem = {
                id: '123',
                parent: {
                    id: '122',
                },
                permissions: {
                    can_delete: true,
                },
                type: 'file',
            } as const;

            let wrapper: any;
            let instance: any;

            beforeEach(() => {
                wrapper = getWrapper({
                    canDelete: true,
                    onDelete: onDeleteMock,
                });
                instance = wrapper.instance();
                instance.api = { getAPI: getApiMock, getCache: jest.fn() };
                instance.refreshCollection = refreshCollectionMock;
                act(() => {
                    instance.setState({
                        selected: boxItem,
                        isDeleteModalOpen: true,
                    });
                });
            });

            afterEach(() => {
                getApiMock.mockClear();
                getApiDeleteMock.mockClear();
                refreshCollectionMock.mockClear();
            });

            test('should call refreshCollection and onDelete callback on success', async () => {
                getApiDeleteMock.mockImplementation((item: any, successCallback: any) => successCallback());
                act(() => {
                    instance.deleteCallback();
                });
                expect(getApiMock).toBeCalledTimes(1);
                expect(getApiDeleteMock).toBeCalledTimes(1);
                expect(onDeleteMock).toBeCalledTimes(1);
                expect(refreshCollectionMock).toBeCalledTimes(1);
            });

            test('should call refreshCollection on error', async () => {
                getApiDeleteMock.mockImplementation((item: any, successCallback: any, errorCallback: any) =>
                    errorCallback(),
                );
                act(() => {
                    instance.deleteCallback();
                });

                expect(getApiMock).toBeCalledTimes(1);
                expect(getApiDeleteMock).toBeCalledTimes(1);
                expect(onDeleteMock).not.toBeCalled();
                expect(refreshCollectionMock).toBeCalledTimes(1);
            });
        });
    });
});
