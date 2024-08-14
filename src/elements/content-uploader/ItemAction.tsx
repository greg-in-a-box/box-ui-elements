import * as React from 'react';
import { useIntl } from 'react-intl';
import { AxiosError } from 'axios';
import { Button, IconButton, LoadingIndicator, Tooltip } from '@box/blueprint-web';
import { ArrowCurveForward, Checkmark } from '@box/blueprint-web-assets/icons/Line';
import { EllipsisBadge, XMark } from '@box/blueprint-web-assets/icons/Fill';
import { Size5, SurfaceStatusSurfaceSuccess } from '@box/blueprint-web-assets/tokens/tokens';

import {
    ERROR_CODE_UPLOAD_FILE_SIZE_LIMIT_EXCEEDED,
    STATUS_PENDING,
    STATUS_IN_PROGRESS,
    STATUS_STAGED,
    STATUS_COMPLETE,
    STATUS_ERROR,
} from '../../constants';

import messages from '../common/messages';

import type { UploadStatus } from '../../common/types/upload';

import './ItemAction.scss';

export interface ItemActionProps {
    error?: AxiosError;
    isFolder?: boolean;
    isResumableUploadsEnabled: boolean;
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    onUpgradeCTAClick?: () => void;
    status: UploadStatus;
}

const getIconWithTooltip = (
    icon: React.ReactNode,
    isDisabled: boolean,
    isLoading: boolean,
    onClick: React.MouseEventHandler<HTMLButtonElement>,
    tooltip: boolean,
    tooltipText: string,
) => {
    if (isLoading) {
        return <LoadingIndicator aria-label="loading" />;
    }

    if (tooltip) {
        return (
            <Tooltip content={tooltipText}>
                <IconButton aria-label={tooltipText} disabled={isDisabled} onClick={onClick} icon={() => icon} />
            </Tooltip>
        );
    }

    return <>{icon}</>;
};

const ItemAction = ({
    error,
    isFolder = false,
    isResumableUploadsEnabled,
    onClick,
    onUpgradeCTAClick,
    status,
}: ItemActionProps) => {
    const intl = useIntl();
    let icon: React.ReactNode = <XMark color="black" height={Size5} width={Size5} />;
    let tooltip;
    let isLoading = false;
    const { code } = error || {};
    const { formatMessage } = intl;

    if (isFolder && status !== STATUS_PENDING) {
        return null;
    }

    switch (status) {
        case STATUS_COMPLETE:
            icon = <Checkmark aria-label="complete" color={SurfaceStatusSurfaceSuccess} height={Size5} width={Size5} />;
            if (!isResumableUploadsEnabled) {
                tooltip = messages.remove;
            }
            break;
        case STATUS_ERROR:
            icon = <ArrowCurveForward aria-label="error" color="black" height={Size5} width={Size5} />;
            tooltip = isResumableUploadsEnabled ? messages.resume : messages.retry;
            break;
        case STATUS_IN_PROGRESS:
        case STATUS_STAGED:
            if (isResumableUploadsEnabled) {
                isLoading = true;
            } else {
                icon = <EllipsisBadge aria-label="staged" color="black" height={Size5} width={Size5} />;
                tooltip = messages.uploadsCancelButtonTooltip;
            }
            break;
        case STATUS_PENDING:
        default:
            if (isResumableUploadsEnabled) {
                isLoading = true;
            } else {
                tooltip = messages.uploadsCancelButtonTooltip;
            }
            break;
    }

    if (status === STATUS_ERROR && code === ERROR_CODE_UPLOAD_FILE_SIZE_LIMIT_EXCEEDED && !!onUpgradeCTAClick) {
        return (
            <Button
                onClick={onUpgradeCTAClick}
                data-resin-target="large_version_error_inline_upgrade_cta"
                variant="primary"
            >
                {intl.formatMessage(messages.uploadsFileSizeLimitExceededUpgradeMessageForUpgradeCta)}
            </Button>
        );
    }
    const isDisabled = status === STATUS_STAGED;
    const tooltipText = tooltip && formatMessage(tooltip);

    return (
        <div className="bcu-item-action">
            {getIconWithTooltip(icon, isDisabled, isLoading, onClick, tooltip, tooltipText)}
        </div>
    );
};

export default ItemAction;
