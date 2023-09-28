# Author: EverStaR and GPTChat V4.5 AI
# Date: 9/27/2023
# Version: 1.1
# Comments and questions to: scripter@everstar.com

# Function to log errors to a CSV file
function LogError {
    param (
        [string]$errorMessage
    )
    $logFilePath = Join-Path $PSScriptRoot "errorlog.csv"
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "$timestamp, $errorMessage`r`n"
    Add-Content -Path $logFilePath -Value $logEntry
}

# Display Summary and Ask for User Confirmation
Write-Host -ForegroundColor Red -NoNewline "`nThis script performs the following actions:`n"
Write-Host -ForegroundColor Red "---------------------------------------------"
Write-Host -ForegroundColor Red "1. Reads a configuration file for file types"
Write-Host -ForegroundColor Red "2. Prompts for source and destination directories"
Write-Host -ForegroundColor Red "3. Generates a category menu for file types"
Write-Host -ForegroundColor Red "4. Copies files based on chosen category"
Write-Host -ForegroundColor Red "---------------------------------------------"

# Display the prompt in Bold Green
Write-Host "`nDo you wish to continue? (yes/no)" -ForegroundColor DarkGreen -NoNewline
$confirmation = Read-Host

# Check user confirmation to continue
if ($confirmation.ToLower().StartsWith('y')) {
    # Continue with the rest of the script
} else {
    Write-Host "Exiting the script."
    exit
}

# Block 1: Read Config File and Initialize Variables
# Initialize Progress Variables
$progressPreference = 'Continue'

# Read file types from config file
$configFilePath = Join-Path $PSScriptRoot "filetypes2.psd1"
if (Test-Path $configFilePath) {
    $fileTypes = Import-PowerShellDataFile $configFilePath
} else {
    Write-Host "Config file not found. Exiting..."
    LogError -errorMessage "Config file not found."
    exit
}

# Prompt for source and destination directories
$rootFolder = Read-Host "Enter the destination directory (default is D:\BACKUP)"
if ([string]::IsNullOrEmpty($rootFolder)) {
    $rootFolder = "D:\BACKUP"
}

$sourceFolder = Read-Host "Enter the source directory (default is C:\)"
if ([string]::IsNullOrEmpty($sourceFolder)) {
    $sourceFolder = "C:\"
}
# Block 2: Generate Category Menu and Select Category Type
do {
    # Generate menu for categories
    $uniqueCategories = $fileTypes.Values | ForEach-Object { $_[0] } | Sort-Object -Unique
    $menuCategories = @{}
    for ($i=0; $i -lt $uniqueCategories.Length; $i++) {
        $menuCategories.Add(($i+1), $uniqueCategories[$i])
    }
    $menuCategories.Add(("a"), "All Categories")
    $menuCategories.Add(("q"), "Quit")

    # Display category menu and get user choice
    Clear-Host
    Write-Host "Mark's Backup Script" -ForegroundColor Cyan
    Write-Host "ID    Category" -ForegroundColor Yellow
    $menuCategories.Keys | Sort-Object | ForEach-Object {
        $id = $_.ToString().PadRight(5)
        $category = $menuCategories[$_].ToString().PadRight(20)
        Write-Host "$id $category" -ForegroundColor White
    }

    $userChoice = Read-Host -Prompt "Choose a category to proceed"
    $userChoice = $userChoice.ToLower()

    if ($userChoice -eq 'q') {
        Write-Host "Exiting..." -ForegroundColor Red
        exit
    }

    if ($userChoice -eq 'a') {
        # Logic for processing all categories
        Write-Host "Processing all categories..."
        break
    }

    $userChoiceInt = 0
    [int]::TryParse($userChoice, [ref]$userChoiceInt)
    $selectedCategory = $menuCategories[$userChoiceInt]

    if ($selectedCategory -ne $null) {
        # Logic for processing selected category
        break
    }
} while ($true)

# Block 3: Select File Types Based on Chosen Category
if ($userChoice -eq 'a') {
    $selectedFileTypes = $fileTypes.Keys
} else {
    $selectedFileTypes = $fileTypes.Keys | Where-Object { $fileTypes[$_][0] -eq $selectedCategory }
}

# Block 4: File Operations and Copying
foreach ($type in $selectedFileTypes) {
    $subFolder = "$rootFolder\$type"
    try {
        $errors = @()
        $files = Get-ChildItem -Path $sourceFolder -Filter "*.$type" -Recurse -ErrorAction SilentlyContinue -ErrorVariable errors
        $totalFiles = $files.Count
        $fileCounter = 0
        if ($totalFiles -gt 0) {
            Write-Progress -Activity "Processing" -CurrentOperation "Initializing folders" -PercentComplete 0
        }
        if (-Not (Test-Path $subFolder)) {
            New-Item -ItemType Directory -Path $subFolder
        }
        foreach ($error in $errors) {
            if ($error.Exception.Message -notlike "Access to the path*" -and $error.Exception.Message -notlike "*OneDrive*") {
                LogError -errorMessage "An error occurred: $($error.Exception.Message)"
            }
        }
        foreach ($file in $files) {
            $fileCounter++
            $destinationFile = "$subFolder\$($file.Name)"
            if (Test-Path $destinationFile) {
                $timestamp = Get-Date -Format "yyyyMMddHHmmss"
                $fileNameWithoutExtension = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
                $fileExtension = [System.IO.Path]::GetExtension($file.Name)
                $newFileName = "$fileNameWithoutExtension`_$timestamp$fileExtension"
                $destinationFile = "$subFolder\$newFileName"
            }
            Copy-Item -Path $file.FullName -Destination $destinationFile
            $percentageComplete = ($fileCounter / $totalFiles) * 100
            Write-Progress -Activity "Copying files" -PercentComplete $percentageComplete -CurrentOperation "Copying $fileCounter of $totalFiles files"
        }
    } catch {
        $errorMsg = $_.Exception.Message
        Write-Host "An exception occurred: $errorMsg"
        LogError -errorMessage $errorMsg
    }
}
