import { ReactNode } from 'react';

interface SidebarProps {
    isOpen: boolean;
    children: ReactNode;
}

export const Sidebar = ({ isOpen, children }: SidebarProps) => {
    return (
        <div className={`transition-all duration-300 ${isOpen ? 'w-64' : 'w-0'} overflow-hidden flex-shrink-0`}>
            {children}
        </div>
    );
};
