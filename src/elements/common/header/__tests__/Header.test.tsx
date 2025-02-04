import * as React from 'react';
import { userEvent } from '@testing-library/user-event';
import { render, screen } from '../../../../test-utils/testing-library';
import Header, { HeaderProps } from '../Header';

describe('elements/common/header/Header', () => {
    const renderComponent = (props?: Partial<HeaderProps>) =>
        render(<Header onSearch={jest.fn()} view="folder" {...props} />);

    test('renders Logo component when isHeaderLogoVisible is `true`', () => {
        renderComponent({ isHeaderLogoVisible: true });
        expect(screen.getByRole('searchbox', { name: 'Search files and folders' })).toBeInTheDocument();

        expect(screen.getByText('Logo')).toBeInTheDocument();
    });

    test('does not render Logo component when isHeaderLogoVisible is `false`', () => {
        renderComponent({ isHeaderLogoVisible: false });
        expect(screen.queryByText('Logo')).not.toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: 'Search files and folders' })).toBeInTheDocument();
    });

    test('disables search input when view is not `folder` and not `search`', () => {
        renderComponent({ view: 'recents' });
        expect(screen.getByRole('searchbox', { name: 'Search files and folders' })).toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: 'Search files and folders' })).toBeDisabled();
    });

    test.each(['folder', 'search'])('does not disable search input when view is %s', view => {
        renderComponent({ view });

        expect(screen.getByRole('searchbox', { name: 'Search files and folders' })).toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: 'Search files and folders' })).not.toBeDisabled();
    });

    test('onSearch is called when search input changes', async () => {
        const onSearch = jest.fn();
        renderComponent({ onSearch });
        const searchInput = screen.getByRole('searchbox', { name: 'Search files and folders' });

        expect(onSearch).not.toHaveBeenCalled();
        await userEvent.type(searchInput, 'test');
        expect(onSearch).toHaveBeenCalled();
    });
});
