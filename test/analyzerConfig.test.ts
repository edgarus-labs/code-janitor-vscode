import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QUALITY_RULES_METADATA } from '../src/cleanup/analyzerRules';
import { isDiagnosticEnforced } from '../src/cleanup/editorConfigRegistry';
import { EditorConfigSeverity, loadEditorConfigProperties, resolveDiagnosticSeverity } from '../src/cleanup/editorconfig';
import { runCleanup } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** A folder with the given files (paths relative to it); returns its path. */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-analyzer-'));
  folders.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }

  return root;
}

function sdkProject(properties = '', items = '', framework = 'net8.0'): string {
  return `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>${framework}</TargetFramework>\n${properties}\n  </PropertyGroup>\n  <ItemGroup>\n${items}\n  </ItemGroup>\n</Project>\n`;
}

/** The effective severity of each CA rule for `App/Sample.cs` in the fixture. */
function severities(root: string, ...ids: string[]): Record<string, EditorConfigSeverity | undefined> {
  const props = loadEditorConfigProperties(path.join(root, 'App', 'Sample.cs'));

  return Object.fromEntries(ids.map((id) => [id, resolveDiagnosticSeverity(props, id, undefined, QUALITY_RULES_METADATA[id].category)]));
}

const EDITORCONFIG_ROOT = 'root = true\n[*.cs]\nindent_style = space\n';

describe('severity from .globalconfig files', () => {
  it('reads .globalconfig files above the source files, below the .editorconfig for the same key', () => {
    const root = fixture({
      '.editorconfig': `${EDITORCONFIG_ROOT}dotnet_diagnostic.CA1825.severity = none\n`,
      '.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1805.severity = warning\ndotnet_diagnostic.CA1825.severity = error\n',
      'App/App.csproj': sdkProject('', '', 'net472'),
      'App/Sample.cs': '',
    });

    expect(severities(root, 'CA1805', 'CA1825')).toEqual({ CA1805: 'warning', CA1825: 'none' });
  });

  it('lets a higher global_level win and ignores keys two configs of the same level disagree on', () => {
    const root = fixture({
      '.editorconfig': EDITORCONFIG_ROOT,
      '.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1805.severity = warning\ndotnet_diagnostic.CA1852.severity = warning\n',
      'App/rules.globalconfig': 'is_global = true\nglobal_level = 200\ndotnet_diagnostic.CA1805.severity = none\n',
      'App/same.globalconfig': 'is_global = true\nglobal_level = 100\ndotnet_diagnostic.CA1852.severity = error\n',
      'App/App.csproj': sdkProject(
        '',
        '    <GlobalAnalyzerConfigFiles Include="rules.globalconfig" />\n    <GlobalAnalyzerConfigFiles Include="$(MSBuildThisFileDirectory)same.globalconfig" />',
        'net472'
      ),
      'App/Sample.cs': '',
    });

    expect(severities(root, 'CA1805', 'CA1852')).toEqual({ CA1805: 'none', CA1852: undefined });
  });

  it('resolves relative <GlobalAnalyzerConfigFiles> items of Directory.Build.props against the project, as MSBuild does', () => {
    const root = fixture({
      '.editorconfig': EDITORCONFIG_ROOT,
      'Directory.Build.props':
        '<Project><ItemGroup><GlobalAnalyzerConfigFiles Include="rules.globalconfig" /><GlobalAnalyzerConfigFiles Include="$(MSBuildThisFileDirectory)shared.globalconfig" /></ItemGroup></Project>',
      'rules.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1805.severity = error\n',
      'shared.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1825.severity = warning\n',
      'App/App.csproj': sdkProject('', '', 'net472'),
      'App/Sample.cs': '',
    });
    expect(severities(root, 'CA1805', 'CA1825')).toEqual({ CA1805: undefined, CA1825: 'warning' });

    fs.writeFileSync(path.join(root, 'App', 'rules.globalconfig'), 'is_global = true\ndotnet_diagnostic.CA1805.severity = suggestion\n');
    expect(severities(root, 'CA1805')).toEqual({ CA1805: 'suggestion' });
  });

  it('reads .globalconfig files above every folder holding compile items of the project, as the SDK does', () => {
    const files = {
      '.editorconfig': EDITORCONFIG_ROOT,
      'App/Sub/.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1805.severity = warning\n',
      'App/Sub/Other.cs': '',
      'App/obj/.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1825.severity = warning\n',
      'App/obj/Generated.cs': '',
      'Shared/.globalconfig': 'is_global = true\ndotnet_diagnostic.CA1852.severity = error\n',
      'Shared/Shared.cs': '',
      'App/Sample.cs': '',
    };
    const sdk = fixture({ ...files, 'App/App.csproj': sdkProject('', '    <Compile Include="..\\Shared\\Shared.cs" />', 'net472') });
    expect(severities(sdk, 'CA1805', 'CA1825', 'CA1852')).toEqual({ CA1805: 'warning', CA1825: undefined, CA1852: 'error' });

    const explicit = fixture({ ...files, 'App/App.csproj': sdkProject('<EnableDefaultCompileItems>false</EnableDefaultCompileItems>', '    <Compile Include="Sample.cs" />', 'net472') });
    expect(severities(explicit, 'CA1805', 'CA1825', 'CA1852')).toEqual({ CA1805: undefined, CA1825: undefined, CA1852: undefined });
  });
});

describe('severity from the project (MSBuild)', () => {
  it('uses the default severity of the analysis level for .NET 5+ projects, and none before a rule existed', () => {
    const root = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject(), 'App/Sample.cs': '' });
    expect(severities(root, 'CA1822', 'CA1805', 'CA2263')).toEqual({ CA1822: 'suggestion', CA1805: 'none', CA2263: 'none' });

    const older = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject('<AnalysisLevel>7</AnalysisLevel>'), 'App/Sample.cs': '' });
    expect(severities(older, 'CA1822', 'CA1860')).toEqual({ CA1822: 'suggestion', CA1860: 'none' });
  });

  it('enables no analyzer by default for .NET Framework projects unless EnableNETAnalyzers is set', () => {
    const framework = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject('', '', 'net472'), 'App/Sample.cs': '' });
    expect(severities(framework, 'CA1822')).toEqual({ CA1822: undefined });

    const enabled = fixture({
      '.editorconfig': EDITORCONFIG_ROOT,
      'App/App.csproj': sdkProject('<EnableNETAnalyzers>true</EnableNETAnalyzers>', '', 'net472'),
      'App/Sample.cs': '',
    });
    expect(severities(enabled, 'CA1822')).toEqual({ CA1822: 'suggestion' });

    const legacy = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': '<Project ToolsVersion="15.0"><PropertyGroup><TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion></PropertyGroup></Project>', 'App/Sample.cs': '' });
    expect(severities(legacy, 'CA1822')).toEqual({ CA1822: undefined });
  });

  it('applies AnalysisMode and compound AnalysisLevel rule sets, which outrank bulk severities', () => {
    const all = fixture({
      '.editorconfig': `${EDITORCONFIG_ROOT}dotnet_analyzer_diagnostic.category-performance.severity = none\n`,
      'App/App.csproj': sdkProject('<AnalysisMode>All</AnalysisMode>'),
      'App/Sample.cs': '',
    });
    expect(severities(all, 'CA1805', 'CA1822')).toEqual({ CA1805: 'warning', CA1822: 'warning' });

    const recommended = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject('<AnalysisLevel>8-recommended</AnalysisLevel>'), 'App/Sample.cs': '' });
    expect(severities(recommended, 'CA1805', 'CA1307', 'CA2263')).toEqual({ CA1805: 'warning', CA1307: 'none', CA2263: 'none' });

    const none = fixture({
      '.editorconfig': `${EDITORCONFIG_ROOT}dotnet_analyzer_diagnostic.severity = warning\ndotnet_diagnostic.CA1825.severity = warning\n`,
      'App/App.csproj': sdkProject('<AnalysisMode>None</AnalysisMode>'),
      'App/Sample.cs': '',
    });
    expect(severities(none, 'CA1822', 'CA1825')).toEqual({ CA1822: 'none', CA1825: 'warning' });
  });

  it('reads category-specific levels and modes and Directory.Build.props, which the project overrides', () => {
    const root = fixture({
      '.editorconfig': EDITORCONFIG_ROOT,
      'Directory.Build.props': '<Project><PropertyGroup><AnalysisMode>All</AnalysisMode><AnalysisModeUsage>None</AnalysisModeUsage></PropertyGroup></Project>',
      'App/App.csproj': sdkProject('<AnalysisModePerformance>Minimum</AnalysisModePerformance>'),
      'App/Sample.cs': '',
    });

    expect(severities(root, 'CA1805', 'CA1822', 'CA2249', 'CA1507')).toEqual({ CA1805: 'none', CA1822: 'warning', CA2249: 'none', CA1507: 'warning' });
  });

  it('turns rules off with NoWarn and escalates warnings with WarningsAsErrors and TreatWarningsAsErrors', () => {
    const root = fixture({
      '.editorconfig': `${EDITORCONFIG_ROOT}dotnet_diagnostic.CA1822.severity = warning\ndotnet_diagnostic.CA1825.severity = warning\ndotnet_diagnostic.CA1829.severity = suggestion\n`,
      'App/App.csproj': sdkProject('<NoWarn>$(NoWarn);CS1591;ca1822</NoWarn>\n<WarningsAsErrors>CA1825</WarningsAsErrors>'),
      'App/Sample.cs': '',
    });
    expect(severities(root, 'CA1822', 'CA1825', 'CA1829')).toEqual({ CA1822: 'none', CA1825: 'error', CA1829: 'suggestion' });

    const all = fixture({
      '.editorconfig': `${EDITORCONFIG_ROOT}dotnet_diagnostic.CA1822.severity = warning\ndotnet_diagnostic.CA1825.severity = warning\n`,
      'App/App.csproj': sdkProject('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>\n<WarningsNotAsErrors>CA1825</WarningsNotAsErrors>'),
      'App/Sample.cs': '',
    });
    expect(severities(all, 'CA1822', 'CA1825')).toEqual({ CA1822: 'error', CA1825: 'warning' });
  });

  it('ignores conditional properties, which cannot be evaluated without MSBuild', () => {
    const root = fixture({
      '.editorconfig': EDITORCONFIG_ROOT,
      'App/App.csproj': sdkProject('<NoWarn Condition="\'$(Configuration)\' == \'Release\'">CA1822</NoWarn>'),
      'App/Sample.cs': '',
    });

    expect(severities(root, 'CA1822')).toEqual({ CA1822: 'suggestion' });
  });
});

describe('which severities make cleanup enforce a rule', () => {
  it('never enforces a rule on its implicit default severity, only on explicit settings', () => {
    const implicit = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject(), 'App/Sample.cs': '' });
    const props = loadEditorConfigProperties(path.join(implicit, 'App', 'Sample.cs'));
    expect(resolveDiagnosticSeverity(props, 'CA1822', undefined, 'Performance')).toBe('suggestion');
    expect(isDiagnosticEnforced(props, 'CA1822')).toBe(false);

    const mode = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject('<AnalysisMode>Minimum</AnalysisMode>'), 'App/Sample.cs': '' });
    const modeProps = loadEditorConfigProperties(path.join(mode, 'App', 'Sample.cs'));
    expect(isDiagnosticEnforced(modeProps, 'CA1822')).toBe(true);
    expect(isDiagnosticEnforced(modeProps, 'CA1805')).toBe(false);
  });

  it('applies the code-style rule set only when AnalysisModeStyle or AnalysisLevelStyle differs', () => {
    const inherited = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject('<AnalysisMode>All</AnalysisMode>'), 'App/Sample.cs': '' });
    const inheritedProps = loadEditorConfigProperties(path.join(inherited, 'App', 'Sample.cs'));
    expect(resolveDiagnosticSeverity(inheritedProps, 'IDE0005')).toBeUndefined();

    const style = fixture({ '.editorconfig': EDITORCONFIG_ROOT, 'App/App.csproj': sdkProject('<AnalysisModeStyle>Minimum</AnalysisModeStyle>'), 'App/Sample.cs': '' });
    const styleProps = loadEditorConfigProperties(path.join(style, 'App', 'Sample.cs'));
    expect(resolveDiagnosticSeverity(styleProps, 'IDE0005')).toBe('warning');
    expect(resolveDiagnosticSeverity(styleProps, 'IDE0004')).toBeUndefined();
    expect(isDiagnosticEnforced(styleProps, 'IDE0005')).toBe(true);
  });

  it('escalates the rule set with CodeAnalysisTreatWarningsAsErrors and exempts CA rules when it is false', () => {
    const escalated = fixture({
      '.editorconfig': EDITORCONFIG_ROOT,
      'App/App.csproj': sdkProject('<AnalysisMode>Minimum</AnalysisMode>\n<CodeAnalysisTreatWarningsAsErrors>true</CodeAnalysisTreatWarningsAsErrors>'),
      'App/Sample.cs': '',
    });
    expect(severities(escalated, 'CA1822')).toEqual({ CA1822: 'error' });

    const exempt = fixture({
      '.editorconfig': `${EDITORCONFIG_ROOT}dotnet_diagnostic.CA1822.severity = warning\ndotnet_diagnostic.IDE0005.severity = warning\n`,
      'App/App.csproj': sdkProject('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>\n<CodeAnalysisTreatWarningsAsErrors>false</CodeAnalysisTreatWarningsAsErrors>'),
      'App/Sample.cs': '',
    });
    const props = loadEditorConfigProperties(path.join(exempt, 'App', 'Sample.cs'));
    expect(resolveDiagnosticSeverity(props, 'CA1822', undefined, 'Performance')).toBe('warning');
    expect(resolveDiagnosticSeverity(props, 'IDE0005')).toBe('error');
  });
});

describe('cleanup with severities from the project only', () => {
  const source = 'class C\n{\n    int[] M() => new int[0];\n}\n';

  it('applies the rules an explicit AnalysisMode enables, without any .editorconfig', () => {
    const root = fixture({ 'App/App.csproj': sdkProject('<AnalysisMode>Minimum</AnalysisMode>'), 'App/Sample.cs': source });
    const output = runCleanup(source, path.join(root, 'App', 'Sample.cs'), createDefaultSettings());

    expect(output).toContain('System.Array.Empty<int>()');
  });

  it('changes nothing on the implicit defaults of a .NET project', () => {
    const root = fixture({ 'App/App.csproj': sdkProject(), 'App/Sample.cs': source });
    const output = runCleanup(source, path.join(root, 'App', 'Sample.cs'), createDefaultSettings());

    expect(output).toContain('new int[0]');
  });
});
