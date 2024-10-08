import { HttpError } from 'wasp/server';
import { getUploadFileSignedURLFromS3, getDownloadFileSignedURLFromS3, deleteFileFromS3 } from './s3Utils';
import { type SharedFile, type User, type File } from 'wasp/entities';
import { type CreateFile, type GetAllFilesByUser, type GetDownloadFileSignedURL } from 'wasp/server/operations';
import { checkAndQueueSharedFileEmails } from '../server/sendEmail';

// Declare the type for sharing files with multiple users
type ShareFileWithUsers = {
  fileKey: string;
  emails: string[]; // Array of emails
};

type FileDescription = {
  fileType: string;
  name: string;
  size: number; // Add size here
};

// Create file
export const createFile: CreateFile<FileDescription, File> = async ({ fileType, name, size }, context) => {
  try {
    if (!context.user) {
      throw new HttpError(401, "Unauthorized");
    }

    const userInfo = context.user.id;
    const { uploadUrl, key } = await getUploadFileSignedURLFromS3({ fileType, userInfo });

    console.log('Signed URL and key:', { uploadUrl, key });

    // Create file record in database, including size
    const fileRecord = await context.entities.File.create({
      data: {
        name,
        key,
        uploadUrl,
        type: fileType,
        size, // Save the file size in the database
        user: { connect: { id: context.user.id } },
      },
    });

    console.log('File record created:', fileRecord);

    return fileRecord;
  } catch (error) {
    console.error('Error in createFile:', error);
    throw error;
  }
};

// Get all files by user
export const getAllFilesByUser: GetAllFilesByUser<void, File[]> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401, "Unauthorized");
  }

  return context.entities.File.findMany({
    where: {
      OR: [
        { userId: context.user.id }, // Files uploaded by the user
        { sharedWith: { some: { sharedWithId: context.user.id } } } // Files shared with the user
      ]
    },
    include: {
      sharedWith: {
        include: {
          sharedBy: true, // Include the user who shared the file
          sharedWith: true // Include the user the file is shared with
        }
      }
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
};





// Get signed URL for file download
export const getDownloadFileSignedURL: GetDownloadFileSignedURL<{ key: string }, string> = async (
  { key },
  _context
) => {
  return await getDownloadFileSignedURLFromS3({ key });
};

////////////////////////////////////////////////////////////////////////////////////////




// Share file with multiple users, including validation and handling non-registered users
export const shareFileWithUsers = async (
  { fileKey, emails }: ShareFileWithUsers,
  context: any
): Promise<{ name: string; senderEmail: string }[]> => {
  if (!context.user) {
    throw new HttpError(401, "Unauthorized");
  }

  // Fetch the original file
  const originalFile = await context.entities.File.findUnique({
    where: { key: fileKey },
    include: { user: true },
  });

  if (!originalFile) {
    throw new HttpError(404, "File not found");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const errors: string[] = [];
  const sharedFiles: { name: string; senderEmail: string }[] = [];

  for (const email of emails) {
    // Validate email format
    if (!emailRegex.test(email)) {
      errors.push(`Invalid email format: ${email}`);
      continue;
    }

    if (email === context.user.email) {
      errors.push(`Cannot share file with yourself: ${email}`);
      continue;
    }

    const user = await context.entities.User.findUnique({ where: { email } });

    if (user) {
      // Check if the user already has the file, if not create a new entry
      const alreadyShared = await context.entities.File.findFirst({
        where: { key: originalFile.key, userId: user.id },
      });

      if (!alreadyShared) {
        // Create a unique key for the recipient
        const uniqueKey = `${context.user.id}/${fileKey}-${Date.now()}`; // Ensure unique key for each share

        await context.entities.File.create({
          data: {
            name: originalFile.name,
            key: uniqueKey, // New unique key
            type: originalFile.type,
            size: originalFile.size,
            user: { connect: { id: user.id } }, // File belongs to the recipient
            originalSenderEmail: context.user.email, // Preserve sender's email
            // Do not include the uploadUrl since the file already exists in S3
          },
        });
      }

      // Create the shared record in the SharedFile table
      await context.entities.SharedFile.create({
        data: {
          file: { connect: { id: originalFile.id } }, // Reference the original file
          sharedWith: { connect: { id: user.id } }, // Connect the recipient
          sharedBy: { connect: { id: context.user.id } }, // Connect the sender
        },
      });

      sharedFiles.push({ name: originalFile.name, senderEmail: context.user.email });
    } else {
      errors.push(`User not registered: ${email}`);
    }
  }

  if (errors.length > 0) {
    throw new HttpError(400, errors.join('\n'));
  }

  if (sharedFiles.length > 0) {
    await checkAndQueueSharedFileEmails(
      { emails: sharedFiles.map((sf) => sf.senderEmail), sharedFiles },
      context
    );
  }

  return sharedFiles;
};














////////////////////////////////////////////////////////////////////////////////////////



// Delete file
export const deleteFile = async ({ fileId }: { fileId: string }, context: any) => {
  if (!context.user) {
    throw new HttpError(401, 'Unauthorized');
  }

  console.log(`Attempting to delete file with id: ${fileId} by user: ${context.user.id}`);

  // Find the file by its key and ensure it belongs to the current user
  const file = await context.entities.File.findUnique({
    where: { key: fileId },
    include: { user: true },
  });

  if (!file) {
    throw new HttpError(404, 'File not found');
  }

  // Check if the current user is the owner of the file
  if (file.userId !== context.user.id) {
    throw new HttpError(403, 'Not authorized to delete this file');
  }

  try {
    // Delete the file record from the database
    await context.entities.File.delete({
      where: { key: fileId },
    });

    // Delete the file from S3
    await deleteFileFromS3({ key: file.key });

    console.log(`File with key: ${file.key} deleted successfully`);
  } catch (error) {
    console.error('Error deleting file:', error);
    throw error;
  }
};

