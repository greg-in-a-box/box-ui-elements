import {
    MetadataInstanceForm,
    type FormValues,
    type JSONPatchOperations,
    type MetadataTemplateInstance,
} from '@box/metadata-editor';
import { type TaxonomyOptionsFetcher } from '@box/metadata-editor/dist/types/lib/components/metadata-editor-fields/components/metadata-taxonomy-field/types';
import React from 'react';
import {
    ERROR_CODE_METADATA_AUTOFILL_TIMEOUT,
    ERROR_CODE_UNKNOWN,
    ERROR_CODE_METADATA_PRECONDITION_FAILED,
} from '../../constants';

export interface MetadataInstanceEditorProps {
    areAiSuggestionsAvailable: boolean;
    errorCode?: ERROR_CODE_METADATA_AUTOFILL_TIMEOUT | ERROR_CODE_METADATA_PRECONDITION_FAILED | ERROR_CODE_UNKNOWN;
    isBetaLanguageEnabled: boolean;
    isBoxAiSuggestionsEnabled: boolean;
    isDeleteButtonDisabled: boolean;
    isLargeFile: boolean;
    isMetadataMultiLevelTaxonomyFieldEnabled: boolean;
    isUnsavedChangesModalOpen: boolean;
    onCancel: () => void;
    onDelete: (metadataInstance: MetadataTemplateInstance) => void;
    onDiscardUnsavedChanges: () => void;
    onSubmit: (values: FormValues, operations: JSONPatchOperations) => Promise<void>;
    setIsUnsavedChangesModalOpen: (isUnsavedChangesModalOpen: boolean) => void;
    taxonomyOptionsFetcher: TaxonomyOptionsFetcher;
    template: MetadataTemplateInstance;
}

const MetadataInstanceEditor: React.FC<MetadataInstanceEditorProps> = ({
    areAiSuggestionsAvailable,
    errorCode,
    isBetaLanguageEnabled,
    isBoxAiSuggestionsEnabled,
    isDeleteButtonDisabled,
    isLargeFile,
    isMetadataMultiLevelTaxonomyFieldEnabled,
    isUnsavedChangesModalOpen,
    onCancel,
    onDelete,
    onDiscardUnsavedChanges,
    onSubmit,
    setIsUnsavedChangesModalOpen,
    taxonomyOptionsFetcher,
    template,
}) => {
    return (
        <MetadataInstanceForm
            // TODO investigate if this property should be optional and by default false
            isMultilevelTaxonomyFieldEnabled={isMetadataMultiLevelTaxonomyFieldEnabled}
            areAiSuggestionsAvailable={areAiSuggestionsAvailable}
            errorCode={errorCode}
            isAiSuggestionsFeatureEnabled={isBoxAiSuggestionsEnabled}
            isBetaLanguageEnabled={isBetaLanguageEnabled}
            isDeleteButtonDisabled={isDeleteButtonDisabled}
            isLargeFile={isLargeFile}
            isUnsavedChangesModalOpen={isUnsavedChangesModalOpen}
            onCancel={onCancel}
            onDelete={onDelete}
            onDiscardUnsavedChanges={onDiscardUnsavedChanges}
            onSubmit={onSubmit}
            selectedTemplateInstance={template}
            setIsUnsavedChangesModalOpen={setIsUnsavedChangesModalOpen}
            taxonomyOptionsFetcher={taxonomyOptionsFetcher}
        />
    );
};

export default MetadataInstanceEditor;
