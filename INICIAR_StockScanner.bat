@echo off
title StockScanner - Control de Inventario
cd /d "%~dp0"

:: Verificar Python
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Python no está instalado.
    echo  Descargalo gratis desde: https://www.python.org/downloads/
    echo  Asegurate de marcar "Add Python to PATH" al instalar.
    echo.
    pause
    exit /b 1
)

:: Ejecutar app
python StockScanner.py
