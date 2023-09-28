# BackupUtility
This is a set of file management scripts for scanning hard drives and harvesting user deemed relevant filetypes.
Certainly! Below is the content for a README.md file that describes the PowerShell script in detail.

---

# Mark's Backup Script: PowerShell Edition

## Table of Contents
- [Introduction](#introduction)
- [Requirements](#requirements)
- [Installation](#installation)
- [How to Enable Script Execution in PowerShell](#how-to-enable-script-execution-in-powershell)
- [Usage](#usage)
- [Detailed Explanation](#detailed-explanation)
- [Error Logging](#error-logging)
- [Contributing](#contributing)
- [License](#license)

## Introduction
This PowerShell script is designed to organize and back up your files. It categorizes files based on their extension and moves them into subdirectories within a root backup directory. The script provides a user interface for selecting which category of files to back up.

## Requirements
- Windows Operating System
- PowerShell 5.1 or higher

## Installation
1. Download the script from this repository.
2. Place it in a directory where you wish to run it.

## How to Enable Script Execution in PowerShell
By default, PowerShell may be configured to not allow the execution of custom scripts. Follow these steps to enable script execution:

1. Open PowerShell as an Administrator.
2. Run `Set-ExecutionPolicy RemoteSigned`.
3. Confirm the change when prompted.

> ⚠️ **Note**: This setting allows scripts downloaded from the internet to be run only if they are signed by a trusted publisher. Please review PowerShell execution policies and the risks involved before proceeding.

## Usage
1. Open PowerShell and navigate to the directory where the script resides.
2. Run `.\BackupScript.ps1`.

## Detailed Explanation
Here's a detailed breakdown of what the script does:

### File Categorization
The script uses a predefined dictionary (`$fileTypes`) to categorize files by their extensions. Each key-value pair in the dictionary maps a file extension to a category and its respective subfolder. For example, `.txt` files may belong to the "Text Files" category and will be moved to a "Text Files" subfolder in the backup root directory.

### User Interface
Upon running the script, the user is presented with a menu that lists the available categories to back up. You can choose a specific category, all categories, or quit the program.

### File Operations
- The script searches for files recursively in a specified source directory.
- Creates subdirectories in a specified root backup directory.
- Copies files into their respective categories.

### Handling Duplicate Names
If a file with the same name already exists in the destination folder, the script appends a timestamp to the file name before copying.

### Error Handling and Logging
Errors, like access restrictions, are captured and logged to an error log file.

## Error Logging
The script logs errors into an `ErrorLog.txt` file in the same directory as the script. The log includes the date and time of the error and the specific error message.

## Contributing
Feel free to submit issues and pull requests.

## License
This project is licensed under the MIT License.

---

You can place this README.md file in the same repository as your script for comprehensive documentation.
