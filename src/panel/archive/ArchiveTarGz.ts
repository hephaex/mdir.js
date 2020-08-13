import * as tar from "tar-stream";
import * as path from "path";
import * as fs from "fs";
import * as zlib from "zlib";
import * as bunzip2 from "unbzip2-stream";

import { ArchiveCommon } from "./ArchiveCommon";
import { File, FileLink } from "../../common/File";
import { Reader, ProgressFunc, IMountList, ProgressResult } from "../../common/Reader";
import { Logger } from "../../common/Logger";
import { Transform, Readable, Stream } from "stream";
import { convertAttrToStatMode, FileReader } from "../FileReader";

const log = Logger("archivetar");

export class ArchiveTarGz extends ArchiveCommon {
    protected isSupportType( file: File ): string {
        let supportType = null;
        let name = this.originalFile.name;
        if ( name.match( /(\.tar\.gz$|\.tgz$)/ ) ) {
            supportType = "tgz";
        } else if ( name.match( /(\.tar\.bz2$|\.tar\.bz$|\.tbz2$|\.tbz$)/ ) ) {
            supportType = "tbz2";
        } else if ( name.match( /(\.tar$)/ ) ) {
            supportType = "tar";
        } else if ( name.match( /\.gz$/ ) ) {
            supportType = "gz";
        } else if ( name.match( /.bz$/ )) {
            supportType = "bz2";
        }
        return supportType;
    }

    checkEmptyDirectory( orgFiles: File[] ): File[] {
        let files = orgFiles;
        let checkDir = (dir: string) => {
            return files.find(item => {
                if ( item.dir && path.format(path.parse(item.fullname)) === dir ) {
                    return true;
                }
                return false;
            });
        };

        let i = 0;
        for( ;; ) {
            if ( i >= files.length ) {
                break;
            }
            if ( !files[i].dir && files[i].dirname !== "/" && !checkDir( files[i].dirname ) ) {
                let file = files[i].clone();
                file.fullname = files[i].dirname + "/";
                file.name = path.basename(files[i].dirname);
                file.orgname = "";
                file.attr = "drwxr-xr-x";
                file.size = 0;
                file.dir = true;
                files.splice( i, 0, file );
            }
            i++;
        }
        return files;
    }

    getArchivedFiles(progress?: ProgressFunc): Promise<File[]> {
        return new Promise( (resolve, reject) => {
            if ( this.supportType === "gz" ) {
                let file = this.originalFile.clone();
                file.fstype = "archive";
                file.name = file.name.substr(file.name.length - 3);
                file.fullname = file.fullname.substr(file.fullname.length - 3);
                resolve( [file] );
                return;
            }

            let resultFiles = [];
            let file = this.originalFile;
            let stream: any = fs.createReadStream(file.fullname);
            let chunkSum = 0;

            const reportProgress = new Transform({
                transform(chunk: Buffer, encoding, callback) {
                    chunkSum += chunk.length;
                    progress && progress( file, chunkSum, file.size, chunk.length );
                    log.debug( "Transform: %s => %d / %d", file.fullname, chunkSum, file.size );
                    callback( null, chunk );
                }
            });

            stream = stream.pipe( reportProgress );

            let outstream: any = null;
            let extract = tar.extract();
            extract.on("entry", (header, stream, next) => {
                resultFiles.push(this.convertTarToFile(header));
                stream.resume();
                next();
            });
            
            if ( this.supportType === "tgz" ) {
                outstream = stream.pipe(zlib.createGunzip());
            } else if ( this.supportType === "tbz2" ) {
                outstream = stream.pipe(bunzip2());
            }
            outstream = outstream.pipe( extract );
            outstream.on("error", (error) => {
                log.error( error );
                reject(error);
            })
            .on("finish", () => {
                log.info( "finish : [%d]", resultFiles.length );
                resultFiles = this.checkEmptyDirectory( resultFiles );
                resolve( resultFiles );
            });
        });
    }

    compress( sourceFile: File[], baseDir: File, targetDirOrNewFile ?: File, progress?: ProgressFunc ): Promise<void> {
        const pack = tar.pack();
        const packEntryPromise = (file: File, stream: Readable, reportProgress?: Transform) => {
            return new Promise( (resolve, reject) => {
                let targetDir = targetDirOrNewFile.fstype === "archive" ? targetDirOrNewFile.fullname : "";
                let header = this.convertFileToTarHeader(file, baseDir, targetDir);
                if ( file.dir || file.link ) {
                    pack.entry( header, (err) => {
                        if ( err ) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                } else {
                    let entry = pack.entry( header, (err) => {
                        log.debug( "Insert File : [%s] [%s]", file.fullname, header.name );
                        if ( err ) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                    stream.on( "error", (err) => {
                        entry.destroy(err);
                    });
                    if ( reportProgress ) {
                        stream.pipe(reportProgress).pipe( entry );
                    } else {
                        stream.pipe( entry );
                    }
                }
            });
        };

        const originFilePacking = () => {
            return new Promise( (resolve, reject) => {
                let tarStream: any = fs.createReadStream(this.originalFile.fullname);
                let extract = tar.extract();
                extract.on("entry", (header, stream, next: any) => {
                    const tarFileInfo = this.convertTarToFile(header);
                    
                    let chunkSum = 0;
                    const reportProgress = new Transform({
                        transform(chunk: Buffer, encoding, callback) {
                            chunkSum += chunk.length;
                            if ( progress ) {
                                const result = progress( tarFileInfo, chunkSum, tarFileInfo.size, chunk.length );
                                if ( result === ProgressResult.USER_CANCELED ) {
                                    extract.destroy();
                                    reject("USER_CANCEL");
                                    return;
                                }
                            }
                            // log.debug( "Transform: %s => %d / %d", tarFileInfo.fullname, chunkSum, file.size );
                            callback( null, chunk );
                        }
                    });

                    packEntryPromise(tarFileInfo, stream, reportProgress).then( () => {
                        next();
                    }).catch( (error) => {
                        reject(error);
                    });
                });

                let outstream = null;
                if ( this.supportType === "tgz" ) {
                    outstream = tarStream.pipe(zlib.createGunzip());
                } else if ( this.supportType === "tbz2" ) {
                    outstream = tarStream.pipe(bunzip2());
                }
                outstream = outstream.pipe( extract );
                outstream.on("error", (error) => {
                    log.error( "ERROR [%s]", error );
                    extract.destroy();
                    reject(error);
                })
                .on("finish", () => {
                    log.info( "originalFileLoader finish !!" );
                    resolve();
                });
            });
        };

        return new Promise( async (resolve, reject) => {
            if ( this.supportType === "tbz2" ) {
                reject("Unsupport bzip2 compress !!!");
                return;
            }

            let tmpWriteFileName = this.originalFile.fullname + ".bak";
            if ( targetDirOrNewFile.fstype === "file" ) {
                tmpWriteFileName = targetDirOrNewFile.fullname;
            }

            let writeNewTarStream = fs.createWriteStream( tmpWriteFileName );
            let outstream = null;

            try {
                writeNewTarStream.on("error", (error) => {
                    log.error( "ERROR [%s]", error );
                    pack.destroy();
                    reject(error);
                });
                if ( this.supportType === "tgz" ) {
                    outstream = pack.pipe(zlib.createGzip()).pipe(writeNewTarStream);
                } else {
                    outstream = pack.pipe(writeNewTarStream);
                }
                outstream.on("error", (error) => {
                    log.error( "ERROR [%s]", error );
                    fs.unlinkSync( tmpWriteFileName );
                    reject(error);
                }).on("finish", () => {
                    log.info( "Compress Finish !!!" );
                    writeNewTarStream.close();
                    fs.unlinkSync( this.originalFile.fullname );
                    fs.renameSync( tmpWriteFileName, this.originalFile.fullname );
                    log.info( "Compress Finish !!!" );
                    resolve();
                });
                
                if ( targetDirOrNewFile.fstype === "archive" ) {
                    await originFilePacking();
                }
                
                for ( let item of sourceFile ) {
                    let stream = null;
                    if ( !item.dir && !item.link ) {
                        stream = fs.createReadStream(item.fullname);
                    }
                    await packEntryPromise(item, stream);
                }
                pack.finalize();
            } catch ( err ) {
                pack.destroy( err );
            }
        });
    }

    uncompress( extractDir: File, files ?: File[], progress?: ProgressFunc ): Promise<void> {
        return new Promise((resolve, reject) => {            
            let extractFiles = [];
            let file = this.originalFile;
            let tarStream: any = fs.createReadStream(file.fullname);
            let filesBaseDir = files && files.length > 0 ? files[0].dirname : "";

            let outstream: any = null;
            let extract = tar.extract();
            extract.on("entry", (header, stream, next: any) => {
                const tarFileInfo = this.convertTarToFile(header);
                if ( files ) {
                    if ( !files.find( item => tarFileInfo.fullname === item.fullname ) ) {
                        stream.resume();
                        next();
                        return;
                    }
                }

                let chunkSum = 0;
                const reportProgress = new Transform({
                    transform(chunk: Buffer, encoding, callback) {
                        chunkSum += chunk.length;
                        if ( progress ) {
                            const result = progress( tarFileInfo, chunkSum, tarFileInfo.size, chunk.length );
                            if ( result === ProgressResult.USER_CANCELED ) {
                                extract.destroy();
                                reject("USER_CANCEL");
                                return;
                            }
                        }
                        // log.debug( "Transform: %s => %d / %d", tarFileInfo.fullname, chunkSum, file.size );
                        callback( null, chunk );
                    }
                });
    
                this.fileStreamWrite( extractDir, filesBaseDir, tarFileInfo, stream, reportProgress, (status: string, err) => {
                    next(err);
                });
                extractFiles.push( tarFileInfo );
            });
            
            if ( this.supportType === "tgz" ) {
                outstream = tarStream.pipe(zlib.createGunzip());
            } else if ( this.supportType === "tbz2" ) {
                outstream = tarStream.pipe(bunzip2());
            }
            outstream = outstream.pipe( extract );
            outstream.on("error", (error) => {
                log.error( "ERROR [%s]", error );
                extract.destroy();
                reject(error);
            })
            .on("finish", () => {
                log.info( "finish : [%d]", extractFiles.length );
                resolve();
            });
        });
    }

    private convertAttr( stats: tar.Headers ): string {
        const fileMode: string[] = "----------".split("");    
        fileMode[0] = stats.type === "block-device" ? "b" : fileMode[0];
        fileMode[0] = stats.type === "character-device" ? "c" : fileMode[0];
        fileMode[0] = stats.type === "fifo" ? "p" : fileMode[0];
        fileMode[0] = stats.type === "directory" ? "d" : fileMode[0];
        fileMode[0] = stats.type === "link" ? "l" : fileMode[0];
        
        fileMode[1] = stats.mode & fs.constants.S_IRUSR ? "r" : "-";
        fileMode[2] = stats.mode & fs.constants.S_IWUSR ? "w" : "-";
        fileMode[3] = stats.mode & fs.constants.S_IXUSR ? "x" : "-";
        fileMode[4] = stats.mode & fs.constants.S_IRGRP ? "r" : "-";
        fileMode[5] = stats.mode & fs.constants.S_IWGRP ? "w" : "-";
        fileMode[6] = stats.mode & fs.constants.S_IXGRP ? "x" : "-";
        fileMode[7] = stats.mode & fs.constants.S_IROTH ? "r" : "-";
        fileMode[8] = stats.mode & fs.constants.S_IWOTH ? "w" : "-";
        fileMode[9] = stats.mode & fs.constants.S_IXOTH ? "x" : "-";
        return fileMode.join("");
    };

    private convertTarToFile(header: tar.Headers): File {
        let file = new File();
        file.fstype = "archive";
        file.fullname = header.name[0] !== "/" ? "/" + header.name : header.name;
        file.orgname = header.name;
        file.name = path.basename(file.fullname);
        file.owner = header.uname;
        if ( header.linkname ) {
            file.link = new FileLink( header.linkname, null );
        }
        file.uid = header.uid;
        file.gid = header.gid;
        file.group = header.gname;
        file.mtime = header.mtime;
        file.root = this.originalFile.fullname;
        file.attr = this.convertAttr(header);
        file.size = header.size;
        file.dir = file.attr[0] === 'd';
        return file;
    };

    private convertFileToTarHeader(file: File, srcBaseDir: File, targetDir: string): tar.Headers {
        const header: tar.Headers = {
            name: file.orgname,
            mode: convertAttrToStatMode(file),
            mtime: file.mtime,
            size: file.size,
            type: file.dir ? "directory": "file",
            uid: file.uid,
            gid: file.gid
        };
        if ( file.fstype === "file" ) {
            header.name = path.normalize(targetDir + file.fullname.substr(srcBaseDir.fullname.length));
            header.name = header.name.replace( /^\//i, "");
        }
        if ( file.link ) {
            header.linkname = file.link.name;
            header.type = "symlink";
            header.size = 0;
        }
        return header;
    };
}
