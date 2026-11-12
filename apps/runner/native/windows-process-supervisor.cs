// Haft Windows process supervisor.
//
// This helper is compiled by the runner on first use (csc.exe ships with the
// .NET Framework on Windows). It owns a Job Object configured with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, creates the CLI suspended, assigns it to
// the job before it can execute a single instruction, and only then resumes
// it. If the supervisor dies for any reason, Windows closes the job handle and
// terminates every member, including descendants.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint WAIT_OBJECT_0 = 0;
    private const int SupervisorFailureExitCode = 70;

    private static Config config;
    private static Guard guard;
    private static IntPtr job = IntPtr.Zero;
    private static IntPtr parentHandle = IntPtr.Zero;
    private static IntPtr cliHandle = IntPtr.Zero;
    private static bool finished;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            config = Config.Parse(args);
            guard = new Guard
            {
                version = 1,
                executionId = config.executionId,
                launchToken = config.launchToken,
                parentPid = (uint)config.parentPid,
                supervisorPid = (uint)Process.GetCurrentProcess().Id,
                supervisorStartTime = GetProcessStartTime(Process.GetCurrentProcess().Handle),
                processGroupId = null,
                cgroupPath = null,
                cliPid = null,
                cliStartTime = null,
                isolation = "windows-job",
                state = "starting",
                jobCreated = false,
                treeConfirmedGone = false,
                exitCode = null,
                signal = null,
                detail = null,
                createdAt = DateTime.UtcNow.ToString("o"),
                updatedAt = DateTime.UtcNow.ToString("o")
            };

            OpenParent();
            CreateJob();
            WriteGuard("starting", false, null, "job object installed; CLI not created yet");

            SpawnCli();
            WriteGuard("running", false, null, null);
            return WaitForTermination();
        }
        catch (Exception error)
        {
            TryTerminateJob();
            WriteGuard(
                guard != null && guard.cliPid.HasValue ? "unconfirmed" : "failed",
                guard == null || !guard.cliPid.HasValue,
                null,
                "supervisor failure: " + error.Message);
            return SupervisorFailureExitCode;
        }
    }

    private static void OpenParent()
    {
        parentHandle = OpenProcess(
            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            (uint)config.parentPid);
        if (parentHandle == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "could not open the runner process");
        }
        long creation;
        long exit;
        long kernel;
        long user;
        if (!GetProcessTimes(parentHandle, out creation, out exit, out kernel, out user))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "could not read the runner start time");
        }
        var actual = DateTime.FromFileTimeUtc(creation);
        var expected = DateTime.Parse(
            config.parentStartTime,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind).ToUniversalTime();
        if (Math.Abs((actual - expected).TotalMilliseconds) > 5)
        {
            throw new InvalidOperationException("runner PID identity does not match the recorded start time");
        }
    }

    private static void CreateJob()
    {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "could not create the job object");
        }
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "could not enable kill-on-close on the job object");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        guard.jobCreated = true;
    }

    private static void SpawnCli()
    {
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10);
        startup.hStdOutput = GetStdHandle(-11);
        startup.hStdError = GetStdHandle(-12);
        SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        var commandLine = Quote(config.command);
        foreach (var argument in config.args)
        {
            commandLine += " " + Quote(argument);
        }

        PROCESS_INFORMATION process;
        if (!CreateProcessW(
                config.command,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                config.cwd,
                ref startup,
                out process))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
        }

        if (!AssignProcessToJobObject(job, process.hProcess))
        {
            TerminateProcess(process.hProcess, 1);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "could not assign the suspended CLI to the job object");
        }

        if (ResumeThread(process.hThread) == 0xFFFFFFFF)
        {
            TerminateJobObject(job, 1);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "could not resume the CLI");
        }

        CloseHandle(process.hThread);
        cliHandle = process.hProcess;
        guard.cliPid = process.dwProcessId;
        guard.cliStartTime = GetProcessStartTime(cliHandle);

        // The CLI owns its inherited stdio handles now. Keeping our copies open
        // would hide EOF/EPIPE from the runner.
        CloseHandle(startup.hStdInput);
        CloseHandle(startup.hStdOutput);
        CloseHandle(startup.hStdError);
    }

    private static int WaitForTermination()
    {
        while (!finished)
        {
            if (WaitForSingleObject(parentHandle, 0) == WAIT_OBJECT_0)
            {
                return TerminateProtected("runner-exited", null);
            }
            if (WaitForSingleObject(cliHandle, 0) == WAIT_OBJECT_0)
            {
                uint exitCode;
                GetExitCodeProcess(cliHandle, out exitCode);
                return TerminateProtected("cli-exited", unchecked((int)exitCode));
            }
            if (File.Exists(config.controlPath))
            {
                string action = ReadControl();
                return TerminateProtected("control:" + action, null);
            }
            Thread.Sleep(100);
        }
        return 0;
    }

    private static int TerminateProtected(string reason, int? exitCode)
    {
        WriteGuard("terminating", false, exitCode, reason);
        TryTerminateJob();

        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            if (ActiveProcesses() == 0)
            {
                var state = reason == "cli-exited" ? "exited" : "terminated";
                WriteGuard(state, true, exitCode, reason);
                finished = true;
                CloseHandle(job);
                job = IntPtr.Zero;
                return exitCode ?? 0;
            }
            TryTerminateJob();
            Thread.Sleep(100);
        }

        // Stay alive to keep tracking the tree. Recovery sees `unconfirmed`
        // and must not finalize this execution.
        WriteGuard("unconfirmed", false, exitCode, reason + "; job is not empty");
        while (!finished)
        {
            TryTerminateJob();
            if (ActiveProcesses() == 0)
            {
                WriteGuard("terminated", true, exitCode, reason + "; later confirmed");
                finished = true;
                CloseHandle(job);
                job = IntPtr.Zero;
                return exitCode ?? 0;
            }
            Thread.Sleep(250);
        }
        return 0;
    }

    private static void TryTerminateJob()
    {
        if (job == IntPtr.Zero) return;
        TerminateJobObject(job, 1);
    }

    private static uint ActiveProcesses()
    {
        if (job == IntPtr.Zero) return 0;
        var info = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        var size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    buffer,
                    (uint)size,
                    IntPtr.Zero))
            {
                return uint.MaxValue;
            }
            info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                buffer,
                typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return info.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string ReadControl()
    {
        try
        {
            var raw = File.ReadAllText(config.controlPath).Trim();
            File.Delete(config.controlPath);
            return raw == "graceful" ? "graceful" : "force";
        }
        catch
        {
            return "force";
        }
    }

    private static void WriteGuard(string state, bool treeConfirmedGone, int? exitCode, string detail)
    {
        if (guard == null) return;
        guard.state = state;
        guard.treeConfirmedGone = treeConfirmedGone;
        if (exitCode.HasValue) guard.exitCode = exitCode.Value;
        guard.detail = detail;
        guard.updatedAt = DateTime.UtcNow.ToString("o");
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(config.guardPath));
            var temporary = config.guardPath + "." + Process.GetCurrentProcess().Id + ".tmp";
            File.WriteAllText(temporary, guard.ToJson() + "\n", new UTF8Encoding(false));
            if (File.Exists(config.guardPath))
            {
                File.Replace(temporary, config.guardPath, null);
            }
            else
            {
                File.Move(temporary, config.guardPath);
            }
        }
        catch
        {
            // The guard is recovery evidence; failure to update it must not
            // cause the supervisor to abandon the protected tree.
        }
    }

    private static string GetProcessStartTime(IntPtr handle)
    {
        long creation;
        long exit;
        long kernel;
        long user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
        {
            return "unknown";
        }
        return DateTime.FromFileTimeUtc(creation).ToString("o");
    }

    private static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return argument;
        }
        var builder = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
            }
            else if (character == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
            }
            else
            {
                builder.Append('\\', backslashes);
                builder.Append(character);
                backslashes = 0;
            }
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private sealed class Config
    {
        public string guardPath;
        public string controlPath;
        public string executionId;
        public string launchToken;
        public int parentPid;
        public string parentStartTime;
        public string cwd;
        public string command;
        public string[] args;

        public static Config Parse(string[] argv)
        {
            var values = new Dictionary<string, string>();
            var separator = Array.IndexOf(argv, "--");
            var head = separator >= 0 ? separator : argv.Length;
            for (var index = 0; index < head; index++)
            {
                if (!argv[index].StartsWith("--") || index + 1 >= head) continue;
                values[argv[index]] = argv[index + 1];
                index++;
            }
            if (separator < 0 || separator + 1 >= argv.Length)
            {
                throw new ArgumentException("missing CLI command after --");
            }
            var result = new Config();
            result.guardPath = Required(values, "--guard");
            result.controlPath = Required(values, "--control");
            result.executionId = Required(values, "--execution-id");
            result.launchToken = Required(values, "--launch-token");
            result.parentPid = int.Parse(Required(values, "--parent-pid"), CultureInfo.InvariantCulture);
            result.parentStartTime = Required(values, "--parent-start");
            string cwd;
            result.cwd = values.TryGetValue("--cwd", out cwd) ? cwd : Directory.GetCurrentDirectory();
            result.command = argv[separator + 1];
            result.args = new string[argv.Length - separator - 2];
            Array.Copy(argv, separator + 2, result.args, 0, result.args.Length);
            return result;
        }

        private static string Required(Dictionary<string, string> values, string name)
        {
            string value;
            if (!values.TryGetValue(name, out value) || string.IsNullOrEmpty(value))
            {
                throw new ArgumentException("missing required supervisor argument " + name);
            }
            return value;
        }
    }

    private sealed class Guard
    {
        public int version;
        public string executionId;
        public string launchToken;
        public uint parentPid;
        public uint supervisorPid;
        public string supervisorStartTime;
        public int? processGroupId;
        public string cgroupPath;
        public uint? cliPid;
        public string cliStartTime;
        public string isolation;
        public string state;
        public bool jobCreated;
        public bool treeConfirmedGone;
        public int? exitCode;
        public string signal;
        public string detail;
        public string createdAt;
        public string updatedAt;

        public string ToJson()
        {
            var builder = new StringBuilder();
            builder.Append("{");
            AppendRaw(builder, "version", version.ToString(CultureInfo.InvariantCulture), true);
            Append(builder, "executionId", executionId, false);
            Append(builder, "launchToken", launchToken, false);
            AppendRaw(builder, "parentPid", parentPid.ToString(CultureInfo.InvariantCulture), false);
            AppendRaw(builder, "supervisorPid", supervisorPid.ToString(CultureInfo.InvariantCulture), false);
            Append(builder, "supervisorStartTime", supervisorStartTime, false);
            builder.Append(",\"processGroupId\":null");
            builder.Append(",\"cgroupPath\":null");
            AppendNullableNumber(builder, "cliPid", cliPid);
            AppendNullable(builder, "cliStartTime", cliStartTime);
            Append(builder, "isolation", isolation, false);
            Append(builder, "state", state, false);
            AppendRaw(builder, "jobCreated", jobCreated ? "true" : "false", false);
            AppendRaw(builder, "treeConfirmedGone", treeConfirmedGone ? "true" : "false", false);
            AppendNullableNumber(builder, "exitCode", exitCode);
            AppendNullable(builder, "signal", signal);
            AppendNullable(builder, "detail", detail);
            Append(builder, "createdAt", createdAt, false);
            Append(builder, "updatedAt", updatedAt, false);
            builder.Append("}");
            return builder.ToString();
        }

        private static void AppendRaw(StringBuilder builder, string name, string raw, bool first)
        {
            if (!first) builder.Append(",");
            builder.Append("\"").Append(Escape(name)).Append("\":").Append(raw);
        }

        private static void Append(StringBuilder builder, string name, string value, bool first)
        {
            if (!first) builder.Append(",");
            builder.Append("\"").Append(Escape(name)).Append("\":\"")
                .Append(Escape(value ?? string.Empty)).Append("\"");
        }

        private static void AppendNullable(StringBuilder builder, string name, string value)
        {
            builder.Append(",\"").Append(Escape(name)).Append("\":");
            if (value == null) builder.Append("null");
            else builder.Append("\"").Append(Escape(value)).Append("\"");
        }

        private static void AppendNullableNumber(StringBuilder builder, string name, uint? value)
        {
            builder.Append(",\"").Append(Escape(name)).Append("\":");
            builder.Append(value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "null");
        }

        private static void AppendNullableNumber(StringBuilder builder, string name, int? value)
        {
            builder.Append(",\"").Append(Escape(name)).Append("\":");
            builder.Append(value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "null");
        }

        private static string Escape(string value)
        {
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n")
                .Replace("\t", "\\t");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr jobHandle,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr jobHandle, IntPtr processHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr jobHandle, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr jobHandle,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr threadHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr processHandle, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr processHandle, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr processHandle,
        out long creationTime,
        out long exitTime,
        out long kernelTime,
        out long userTime);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
