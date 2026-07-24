// Central UI kit — genuine Astryx (Meta design system) components + a professional
// lucide icon set. Single import surface so every view uses the same real primitives.

// Shell / navigation
export { AppShell } from '@astryxdesign/core/AppShell';
export { SideNav } from '@astryxdesign/core/SideNav';
export { SideNavHeading } from '@astryxdesign/core/SideNav';
export { SideNavItem } from '@astryxdesign/core/SideNav';
export { SideNavSection } from '@astryxdesign/core/SideNav';
export { TopNav } from '@astryxdesign/core/TopNav';
export { TopNavHeading } from '@astryxdesign/core/TopNav';
export { MobileNav, MobileNavToggle } from '@astryxdesign/core/MobileNav';

// Layout primitives
export { Stack } from '@astryxdesign/core/Stack';
export { HStack } from '@astryxdesign/core/HStack';
export { VStack } from '@astryxdesign/core/VStack';
export { StackItem } from '@astryxdesign/core/Stack';
export { Grid } from '@astryxdesign/core/Grid';
export { Section } from '@astryxdesign/core/Section';
export { Divider } from '@astryxdesign/core/Divider';

// Surfaces
export { Card } from '@astryxdesign/core/Card';
export { ClickableCard } from '@astryxdesign/core/ClickableCard';

// Typography
export { Heading } from '@astryxdesign/core/Heading';
export { Text } from '@astryxdesign/core/Text';

// Controls
export { Button } from '@astryxdesign/core/Button';
export { IconButton } from '@astryxdesign/core/IconButton';
export { ToggleButton } from '@astryxdesign/core/ToggleButton';
export { SegmentedControl } from '@astryxdesign/core/SegmentedControl';
export { SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
export { TextInput } from '@astryxdesign/core/TextInput';
export { TextArea } from '@astryxdesign/core/TextArea';
export { FileInput } from '@astryxdesign/core/FileInput';
export { Selector } from '@astryxdesign/core/Selector';

// Tabs
export { TabList } from '@astryxdesign/core/TabList';
export { Tab } from '@astryxdesign/core/TabList';

// Data display
export { Table } from '@astryxdesign/core/Table';
export { Badge } from '@astryxdesign/core/Badge';
export { StatusDot } from '@astryxdesign/core/StatusDot';
export { MetadataList } from '@astryxdesign/core/MetadataList';
export { MetadataListItem } from '@astryxdesign/core/MetadataList';
export { Item } from '@astryxdesign/core/Item';
export { ProgressBar } from '@astryxdesign/core/ProgressBar';
export { EmptyState } from '@astryxdesign/core/EmptyState';
export { Banner } from '@astryxdesign/core/Banner';
export { Spinner } from '@astryxdesign/core/Spinner';
export { Skeleton } from '@astryxdesign/core/Skeleton';
export { Tooltip } from '@astryxdesign/core/Tooltip';
export { Icon } from '@astryxdesign/core/Icon';
export { Markdown } from '@astryxdesign/core/Markdown';
export { Citation } from '@astryxdesign/core/Citation';
export { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';

// Chat
export { ChatLayout } from '@astryxdesign/core/Chat';
export { ChatMessageList } from '@astryxdesign/core/Chat';
export { ChatMessage } from '@astryxdesign/core/Chat';
export { ChatMessageBubble } from '@astryxdesign/core/Chat';
export { ChatMessageMetadata } from '@astryxdesign/core/Chat';
export { ChatComposer } from '@astryxdesign/core/Chat';

// Table column-width helpers (small, stable shape from Astryx table types).
export const proportional = (value, minWidth) => ({ type: 'proportional', value, ...(minWidth ? { minWidth } : {}) });
export const pixel = (value) => ({ type: 'pixel', value });

// Professional icon set (lucide) — no emoji anywhere in the product.
export {
  Shield, ShieldCheck, MessagesSquare, ChartNoAxesCombined, Radar, Search,
  FileText, FileUp, Network, MapPin, Users, Banknote, Landmark, Coins,
  TriangleAlert, Sparkles, Mic, Square, Send, Download, Volume2,
  ArrowUpRight, ArrowDownRight, ArrowUp, ArrowDown, Minus, Clock, Scale,
  Gavel, Building2, TrendingUp, TrendingDown, Activity, CircleDot, ChevronRight,
  Plus, Filter, Globe, Languages, Brain, Layers, Target, CheckCircle2,
  CircleAlert, Route, Fingerprint, ScrollText, UserRound, ShieldAlert,
  BadgeCheck, Waypoints, GitBranch, Timer, Flame, Server, Upload, X, Menu,
  Database, RefreshCw, LockKeyhole, FileSearch, CircleCheckBig, WandSparkles,
} from 'lucide-react';
