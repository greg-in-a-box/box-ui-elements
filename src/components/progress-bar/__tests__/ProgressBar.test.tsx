import * as React from 'react';
import { shallow } from 'enzyme';

import ProgressBar from '..';

describe('components/progress-bar/ProgressBar', () => {
    const renderComponent = (props = {}) => shallow(<ProgressBar {...props} />);

    test('should render a progress bar with the input width', () => {
        const expected = {
            width: '20%',
        };

        const component = renderComponent({
            progress: 20,
        });
        expect(component.find('.progress-bar').props().style?.width).toEqual(expected.width);
    });

    test('should render a progress bar with the input width and className', () => {
        const className = 'dis be a className';
        const expected = {
            className,
            width: '20%',
        };

        const component = renderComponent({
            className,
            progress: 20,
        });
        expect(
            component
                .find('.progress-bar')
                .props()
                .className?.indexOf(expected.className) !== -1,
        ).toBeTruthy();
        expect(component.find('.progress-bar').props().style?.width).toEqual(expected.width);
    });
});
