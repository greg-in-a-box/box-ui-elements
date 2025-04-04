import React, { useCallback, useState } from 'react';
import getProp from 'lodash/get';

import ContentAnswersModal, { ExternalProps as ContentAnswersModalExternalProps } from './ContentAnswersModal';
import ContentAnswersOpenButton from './ContentAnswersOpenButton';
// @ts-ignore: no ts definition
import { BoxItem } from '../../common/types/core';

interface ExternalProps extends ContentAnswersModalExternalProps {
    show?: boolean;
}

interface Props {
    className?: string;
    file: BoxItem;
}

const ContentAnswers = (props: ContentAnswersModalExternalProps & Props) => {
    const { className = '', file, onAsk, onRequestClose, ...rest } = props;

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [hasQuestions, setHasQuestions] = useState(false);
    const [isHighlighted, setIsHighlighted] = useState(false);

    const handleClick = useCallback(() => {
        setIsModalOpen(true);
    }, [setIsModalOpen]);

    const handleClose = useCallback(() => {
        setIsModalOpen(false);
        if (hasQuestions) {
            setIsHighlighted(true);
        }

        if (onRequestClose) {
            onRequestClose();
        }
    }, [hasQuestions, onRequestClose]);

    const handleAsk = useCallback(() => {
        setHasQuestions(true);
        if (onAsk) {
            onAsk();
        }
    }, [onAsk]);

    const currentExtension = getProp(file, 'extension');
    return (
        <div className={`be-ContentAnswers ${className}`}>
            <ContentAnswersOpenButton
                fileExtension={currentExtension}
                isHighlighted={isHighlighted}
                isModalOpen={isModalOpen}
                onClick={handleClick}
            />
            <ContentAnswersModal
                file={file}
                isOpen={isModalOpen}
                onAsk={handleAsk}
                onRequestClose={handleClose}
                {...rest}
            />
        </div>
    );
};

export type ContentAnswersProps = ExternalProps & Props;
export default ContentAnswers;
